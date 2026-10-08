import { DatabaseSync } from 'node:sqlite'
import http from 'node:http'
import { statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import type { Publication, ServiceKind } from '../shared/contracts'
import type { DirectoryScan } from './catalog'

export function readPackageMetadata(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT name, value FROM metadata').all() as {
    name: string
    value: string
  }[]
  return Object.fromEntries(rows.map((row) => [row.name, row.value]))
}
export function scanPackage(filename: string, kind: ServiceKind): DirectoryScan {
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const metadata = readPackageMetadata(db)
    if (metadata['geopress:complete'] === '0') {
      throw new Error('成果包尚未完成')
    }
    if (kind === 'imagery' && !['png', 'jpg', 'jpeg', 'webp'].includes(metadata.format)) {
      throw new Error('仅支持栅格影像 MBTiles，矢量 PBF 包不适用于影像服务')
    }
    let layer: Record<string, unknown> | undefined
    if (kind === 'terrain') {
      if (metadata['geopress:container'] !== 'quantized-mesh-sqlite-v1') {
        throw new Error('请选择 GeoPress Quantized Mesh SQLite 地形包')
      }
      layer = JSON.parse(metadata['layer.json'])
      if (
        layer?.format !== 'quantized-mesh-1.0' ||
        !Array.isArray(layer.available) ||
        !Array.isArray(layer.tiles)
      ) {
        throw new Error('地形包 layer.json 无效')
      }
    } else if (kind !== 'imagery') {
      throw new Error('此类型不支持瓦片包发布')
    }
    const aggregate = db
      .prepare(
        'SELECT count(*) AS count, min(zoom_level) AS min, max(zoom_level) AS max FROM tiles',
      )
      .get() as { count: number; min: number; max: number }
    if (!aggregate.count) {
      throw new Error('包内没有瓦片')
    }
    const sample = db
      .prepare(
        'SELECT zoom_level AS z, tile_column AS x, tile_row AS y, tile_data AS data FROM tiles LIMIT 20',
      )
      .all() as { z: number; x: number; y: number; data: Uint8Array }[]
    const compressed =
      kind === 'terrain' && sample[0].data[0] === 0x1f && sample[0].data[1] === 0x8b
    if (
      kind === 'terrain' &&
      sample.some((tile) => {
        const gzip = tile.data[0] === 0x1f && tile.data[1] === 0x8b
        return gzip !== compressed || (gzip ? gunzipSync(tile.data) : tile.data).length < 92
      })
    ) {
      throw new Error('地形瓦片编码混合或内容不完整')
    }
    const bounds = metadata.bounds?.split(',').map(Number)
    return {
      storage: 'package',
      valid: true,
      reason: '单文件瓦片包有效',
      count: aggregate.count,
      minZoom: aggregate.min,
      maxZoom: aggregate.max,
      compressed,
      bounds: bounds?.length === 4 && bounds.every(Number.isFinite) ? bounds : undefined,
      indexedAt: new Date().toISOString(),
      indexed: sample.map((tile) => ({
        path: `${tile.z}/${tile.x}/${kind === 'imagery' && metadata.scheme !== 'xyz' ? 2 ** tile.z - 1 - tile.y : tile.y}.${kind === 'terrain' ? 'terrain' : metadata.format === 'jpeg' ? 'jpg' : metadata.format}`,
        size: tile.data.byteLength,
        modified: new Date().toISOString(),
      })),
    }
  } finally {
    db.close()
  }
}

/** Local read-only tile gateway behind Nginx. Bounded handles reopen after file replacement. */
export class TilePackageServer {
  port = 0
  private handles = new Map<
    string,
    { db: DatabaseSync; version: string; metadata: Record<string, string> }
  >()
  private server: http.Server
  constructor(private publications: () => Publication[]) {
    this.server = http.createServer((req, res) => {
      try {
        if (!['GET', 'HEAD'].includes(req.method ?? '')) {
          res.writeHead(405).end()
          return
        }
        const route = new URL(req.url ?? '/', 'http://localhost').pathname
        const match = /^\/([^/]+)\/(layer\.json|\d+\/\d+\/\d+\.(?:png|jpe?g|webp|terrain))$/.exec(
          route,
        )
        const publication =
          match &&
          this.publications().find(
            (p) => p.id === match[1] && p.storage === 'package' && p.enabled && p.valid,
          )
        if (!publication || !match) {
          res.writeHead(404).end()
          return
        }
        const info = statSync(publication.directory)
        const version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
        let handle = this.handles.get(publication.directory)
        if (handle?.version !== version) {
          handle?.db.close()
          this.handles.delete(publication.directory)
          const db = new DatabaseSync(publication.directory, { readOnly: true })
          handle = { db, version, metadata: readPackageMetadata(db) }
        }
        this.handles.delete(publication.directory)
        this.handles.set(publication.directory, handle)
        while (this.handles.size > 8) {
          const oldest = this.handles.keys().next().value!
          this.handles.get(oldest)!.db.close()
          this.handles.delete(oldest)
        }
        let data: Buffer
        let type: string
        if (match[2] === 'layer.json' && publication.kind === 'terrain') {
          const layer = JSON.parse(handle.metadata['layer.json'])
          layer.tiles = ['{z}/{x}/{y}.terrain']
          data = Buffer.from(JSON.stringify(layer))
          type = 'application/json'
        } else {
          const tile = /^(\d+)\/(\d+)\/(\d+)\.(png|jpe?g|webp|terrain)$/.exec(match[2])
          if (!tile) {
            res.writeHead(404).end()
            return
          }
          const [, zoom, column, row, extension] = tile
          const z = Number(zoom)
          const x = Number(column)
          const y = Number(row)
          const expected =
            publication.kind === 'terrain'
              ? 'terrain'
              : handle.metadata.format === 'jpeg'
                ? 'jpg'
                : handle.metadata.format
          if (
            extension !== expected ||
            z > 22 ||
            x >= (publication.kind === 'terrain' ? 2 : 1) * 2 ** z ||
            y >= 2 ** z
          ) {
            res.writeHead(404).end()
            return
          }
          const storedRow =
            publication.kind === 'imagery' && handle.metadata.scheme !== 'xyz' ? 2 ** z - 1 - y : y
          const result = handle.db
            .prepare(
              'SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?',
            )
            .get(z, x, storedRow) as { tile_data: Uint8Array } | undefined
          if (!result) {
            res.writeHead(404).end()
            return
          }
          data = Buffer.from(result.tile_data)
          type =
            publication.kind === 'terrain'
              ? 'application/vnd.quantized-mesh'
              : extension === 'jpg'
                ? 'image/jpeg'
                : `image/${extension}`
          if (publication.kind === 'terrain' && data[0] === 0x1f && data[1] === 0x8b) {
            res.setHeader('Content-Encoding', 'gzip')
          }
        }
        res.setHeader('Content-Type', type)
        res.setHeader('Content-Length', data.length)
        res.setHeader('ETag', `"${version}-${match[2]}"`)
        if (req.headers['if-none-match'] === res.getHeader('ETag')) {
          res.writeHead(304).end()
        } else {
          res.writeHead(200).end(req.method === 'HEAD' ? undefined : data)
        }
      } catch {
        res.writeHead(503).end()
      }
    })
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.port = (this.server.address() as { port: number }).port
  }
  async close() {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    for (const handle of this.handles.values()) {
      handle.db.close()
    }
    this.handles.clear()
  }
}
