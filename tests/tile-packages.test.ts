import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { scanDirectory } from '../server/catalog'
import { TilePackageServer } from '../server/tile-packages'
import { findExecutable } from '../server/infrastructure/executables'
import { NginxServer } from '../server/nginx'
import type { Publication, Settings } from '../shared/contracts'
import { createServer } from 'node:net'

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
function fixture(filename: string, kind: 'imagery' | 'terrain') {
  const db = new DatabaseSync(filename)
  db.exec(
    'CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level,tile_column,tile_row))',
  )
  const meta = db.prepare('INSERT INTO metadata VALUES (?,?)')
  meta.run('format', kind === 'imagery' ? 'png' : 'quantized-mesh-1.0')
  meta.run('scheme', 'tms')
  meta.run('bounds', '110,29,111,30')
  if (kind === 'terrain') {
    meta.run('geopress:container', 'quantized-mesh-sqlite-v1')
    meta.run(
      'layer.json',
      JSON.stringify({
        format: 'quantized-mesh-1.0',
        scheme: 'tms',
        tiles: ['{z}/{x}/{y}.terrain'],
        available: [[{ startX: 1, startY: 0, endX: 1, endY: 0 }]],
      }),
    )
  }
  const payload =
    kind === 'imagery' ? Buffer.from('north-row-image') : gzipSync(Buffer.alloc(100, 1))
  db.prepare('INSERT INTO tiles VALUES (?,?,?,?)').run(
    kind === 'imagery' ? 2 : 0,
    1,
    kind === 'imagery' ? 3 : 0,
    payload,
  )
  db.close()
  return payload
}

test('single-file publication through real Nginx preserves XYZ/TMS mapping, CORS, gzip and HEAD', async (t) => {
  const binary = await findExecutable('', ['nginx', '/opt/homebrew/bin/nginx'])
  if (!binary) {
    t.skip('Nginx unavailable')
    return
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'geopress-package-')))
  const imageFile = path.join(root, '影像.mbtiles')
  const terrainFile = path.join(root, '地形.terrain.sqlite')
  const imagePayload = fixture(imageFile, 'imagery')
  fixture(terrainFile, 'terrain')
  const publications: Publication[] = []
  for (const [kind, filename] of [
    ['imagery', imageFile],
    ['terrain', terrainFile],
  ] as const) {
    publications.push({
      id: kind,
      name: kind,
      kind,
      directory: filename,
      mount: `/${kind}/`,
      enabled: true,
      ...(await scanDirectory(filename, kind)),
    })
  }
  assert.ok(publications.every((p) => p.valid && p.storage === 'package'))
  const gateway = new TilePackageServer(() => publications)
  await gateway.start()
  const nginx = new NginxServer(path.join(root, 'nginx'))
  nginx.packagePort = gateway.port
  const settings: Settings = {
    port: await freePort(),
    host: '127.0.0.1',
    nginx: binary,
    python: '',
    gdal: '',
    terrain: '',
    osgb: '',
    cacheSeconds: 0,
    taskConcurrency: 1,
    workerBudget: 1,
  }
  const base = `http://127.0.0.1:${settings.port}`
  try {
    await nginx.start(binary, settings, publications)
    const response = await fetch(base + '/imagery/2/1/0.png')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), imagePayload)
    assert.equal((await fetch(base + '/imagery/2/1/3.png')).status, 404)
    const head = await fetch(base + '/imagery/2/1/0.png', { method: 'HEAD' })
    assert.equal(head.headers.get('content-length'), String(imagePayload.length))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    const cached = await fetch(base + '/imagery/2/1/0.png', {
      headers: { 'If-None-Match': response.headers.get('etag')! },
    })
    assert.equal(cached.status, 304)
    const layer = await fetch(base + '/terrain/layer.json')
    assert.equal(layer.headers.get('content-encoding'), null)
    assert.equal((await layer.json()).format, 'quantized-mesh-1.0')
    const terrain = await fetch(base + '/terrain/0/1/0.terrain')
    assert.equal(terrain.headers.get('content-encoding'), 'gzip')
    assert.deepEqual(Buffer.from(await terrain.arrayBuffer()), Buffer.alloc(100, 1))
    publications[0].enabled = false
    assert.equal((await fetch(base + '/imagery/2/1/0.png')).status, 404)
  } finally {
    await nginx.stop()
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('wrong-kind, unfinished and vector packages are rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'geopress-invalid-package-'))
  const filename = path.join(root, 'test.mbtiles')
  try {
    fixture(filename, 'imagery')
    assert.equal((await scanDirectory(filename, 'terrain')).valid, false)
    const db = new DatabaseSync(filename)
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('geopress:complete', '0')
    db.close()
    assert.equal((await scanDirectory(filename, 'imagery')).valid, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
