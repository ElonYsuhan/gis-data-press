import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, unlink, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { Manager } from './manager'
const [dataDirectory, project, resources] = process.argv.slice(2)
if (!dataDirectory || !project || !resources) {
  throw new Error('后台启动参数缺失')
}
const lock = path.join(dataDirectory, 'service.lock')
const endpointFile = path.join(dataDirectory, 'service.json')
let manager: Manager | undefined
let server: http.Server | undefined
let closing = false
let ownsLock = false
async function shutdown(stopPublishing = false) {
  if (closing) {
    return
  }
  closing = true
  if (server) {
    server.close()
    server.closeAllConnections()
  }
  await manager?.close({ keepPublishing: !stopPublishing })
  if (ownsLock) {
    await unlink(endpointFile).catch(() => {})
    await unlink(lock).catch(() => {})
  }
  process.exit(0)
}
async function main() {
  await mkdir(dataDirectory, { recursive: true })
  try {
    const owner = Number(await readFile(lock, 'utf8'))
    process.kill(owner, 0)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      await unlink(lock).catch(() => {})
    } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  const handle = await open(lock, 'wx', 0o600)
  ownsLock = true
  await handle.writeFile(String(process.pid))
  await handle.close()
  manager = new Manager(dataDirectory, project, resources)
  await manager.initialize()
  const token = randomBytes(32).toString('hex')
  const methods: Record<string, (...args: any[]) => unknown> = {
    ping: () => ({ pid: process.pid, protocol: 4 }),
    listResources: () => manager!.listResources(),
    searchBoundaries: (...a: any[]) => manager!.searchBoundaries(a[0]),
    downloadResource: (...a: any[]) => manager!.downloadResource(a[0]),
    registerResource: (...a: any[]) => manager!.registerResource(a[0], a[1]),
    cancelDownload: (...a: any[]) => manager!.cancelDownload(a[0]),
    forgetResource: (...a: any[]) => manager!.forgetResource(a[0]),
    snapshot: () => manager!.snapshot(),
    inspect: (p) => manager!.inspect(p),
    savePublication: (p) => manager!.savePublication(p),
    togglePublication: (id) => manager!.togglePublication(id),
    removePublication: (id) => manager!.removePublication(id),
    refresh: () => manager!.refresh(),
    saveSettings: (s) => manager!.saveSettings(s),
    server: (a) => manager!.server(a),
    submit: (r) => manager!.submit(r),
    cancel: (id) => manager!.cancel(id),
    shutdown: () => {
      setTimeout(() => void shutdown(true), 30)
      return null
    },
  }
  server = http.createServer(async (req, res) => {
    try {
      if (
        req.method !== 'POST' ||
        req.headers.authorization !== `Bearer ${token}` ||
        req.headers.origin
      ) {
        res.writeHead(403).end()
        return
      }
      const name = (req.url ?? '').slice(1)
      if (!Object.hasOwn(methods, name)) {
        res.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (Buffer.byteLength(body) > 1024 * 1024) {
          res.writeHead(413).end()
          return
        }
      }
      const args: unknown = JSON.parse(body)
      if (!Array.isArray(args)) {
        throw new Error('参数无效')
      }
      const result = await methods[name](...args)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result: result ?? null }))
    } catch (error) {
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: String(error) }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('后台端口分配失败')
  }
  await writeFile(
    endpointFile + '.tmp',
    JSON.stringify({ pid: process.pid, port: address.port, token }),
    { mode: 0o600 },
  )
  await rename(endpointFile + '.tmp', endpointFile)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
void main().catch(async (error) => {
  console.error(error)
  await shutdown()
  process.exitCode = 1
})
