import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

// A separate loopback management server; never exposed on the GIS listening address.
export async function startBrowserUI(
  root: string,
  methods: Record<string, (...args: any[]) => any>,
) {
  const token = randomBytes(32).toString('hex')
  const canonical = await realpath(root)
  let origin = ''
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) {
        res.writeHead(403).end()
        return
      }
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const url = new URL(req.url ?? '/', origin)
      if (url.pathname.startsWith('/api/')) {
        if (
          req.method !== 'POST' ||
          req.headers.origin !== origin ||
          req.headers.authorization !== `Bearer ${token}`
        ) {
          res.writeHead(403).end()
          return
        }
        const name = url.pathname.slice(5)
        if (!Object.hasOwn(methods, name) || name === 'openBrowser') {
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
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end()
        return
      }
      const file = await realpath(
        path.resolve(
          canonical,
          '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
        ),
      )
      if (!file.startsWith(canonical + path.sep)) {
        res.writeHead(403).end()
        return
      }
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.wasm': 'application/wasm',
      }
      res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream')
      res.end(req.method === 'HEAD' ? undefined : await readFile(file))
    } catch (error) {
      res
        .writeHead(req.url?.startsWith('/api/') ? 400 : 404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: String(error) }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('管理服务启动失败')
  }
  origin = `http://127.0.0.1:${address.port}`
  return {
    url: `${origin}/#${token}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
