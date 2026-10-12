import http from 'node:http'
import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { open, mkdir, readdir, lstat, rename, rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LanPeer, LanMessage, LanTransfer, LanSnapshot } from '../shared/lan'

const GROUP = '239.255.77.77'
const DISCOVERY_PORT = 45872
const CHUNK = 4 * 1024 * 1024
interface Entry {
  name: string
  size: number
  directory: boolean
  source?: string
  mtime?: number
}
interface Peer extends LanPeer {
  seen: number
  token: string
}
const cleanName = (name: string) => {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/:\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)
  ) {
    throw new Error('文件名称不兼容：' + name)
  }
  return name
}
function safeRelative(name: string) {
  return name.split('/').map(cleanName).join(path.sep)
}
function ipv4(ip: string) {
  return ip.replace(/^::ffff:/, '')
}
function numberIP(ip: string) {
  return ip.split('.').reduce((n, part) => (n << 8) | Number(part), 0) >>> 0
}
function interfaces() {
  return Object.entries(networkInterfaces())
    .filter(
      ([name]) =>
        !/^(utun|tun|tap|veth|docker|bridge|vmnet|vbox|awdl|llw|lo)|vethernet|virtualbox|vpn/i.test(
          name,
        ),
    )
    .flatMap(([, list]) => list ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
}
function trusted(ip: string, loopback: boolean) {
  ip = ipv4(ip)
  if (loopback && ip === '127.0.0.1') {
    return true
  }
  return interfaces().some(
    (item) =>
      (numberIP(ip) & numberIP(item.netmask)) === (numberIP(item.address) & numberIP(item.netmask)),
  )
}
async function jsonBody(req: http.IncomingMessage) {
  const buffers: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) {
      throw new Error('消息过大')
    }
    buffers.push(chunk)
  }
  return JSON.parse(Buffer.concat(buffers).toString())
}
export class LanChat {
  id: string = randomUUID()
  private token = randomBytes(32).toString('hex')
  private peers = new Map<string, Peer>()
  private messages: LanMessage[] = []
  private transfers: LanTransfer[] = []
  private outgoing = new Map<string, Entry[]>()
  private controllers = new Map<string, AbortController>()
  private receiving = new Set<Promise<void>>()
  private server?: http.Server
  private udp?: dgram.Socket
  private timer?: ReturnType<typeof setInterval>
  private port = 0
  private error = ''
  private saving: Promise<void> = Promise.resolve()
  private closed = false
  constructor(
    private dataDirectory: string,
    private options: { discovery?: boolean; loopback?: boolean; name?: string } = {},
  ) {}
  async start() {
    await mkdir(this.dataDirectory, { recursive: true })
    const identity = path.join(this.dataDirectory, 'identity')
    try {
      const saved = await readFile(identity, 'utf8')
      if (/^[a-f0-9-]{36}$/.test(saved)) {
        this.id = saved
      }
    } catch {}
    await writeFile(identity, this.id, { mode: 0o600 })
    try {
      const history = JSON.parse(
        await readFile(path.join(this.dataDirectory, 'history.json'), 'utf8'),
      )
      this.messages = history.messages ?? []
      this.transfers = (history.transfers ?? []).map((t: LanTransfer) =>
        ['offered', 'transferring'].includes(t.status)
          ? { ...t, status: 'failed', error: '软件已重新启动，请重新发送' }
          : t,
      )
    } catch {}
    this.server = http.createServer((req, res) => {
      void this.handle(req, res)
    })
    this.server.requestTimeout = 0
    this.server.headersTimeout = 15000
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '0.0.0.0', resolve)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('聊天端口启动失败')
    }
    this.port = address.port
    this.server.on('error', (error) => {
      this.error = error.message
    })
    if (this.options.discovery === false) {
      return
    }
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.udp.on('error', (error) => {
      this.error = '自动发现不可用：' + error.message
    })
    this.udp.on('message', (buffer, remote) => {
      try {
        if (!trusted(remote.address, !!this.options.loopback)) {
          return
        }
        const message = JSON.parse(buffer.toString())
        if (
          message.app !== 'geopress-lan-v1' ||
          typeof message.id !== 'string' ||
          message.id === this.id
        ) {
          return
        }
        if (message.bye) {
          const peer = this.peers.get(message.id)
          if (peer) {
            peer.seen = 0
          }
          return
        }
        if (
          !Number.isInteger(message.port) ||
          message.port < 1 ||
          message.port > 65535 ||
          !/^[a-f0-9]{64}$/.test(message.token)
        ) {
          return
        }
        this.peers.set(message.id, {
          id: message.id,
          name:
            typeof message.name === 'string'
              ? message.name.slice(0, 32)
              : remote.address.split('.').at(-1)!,
          ip: remote.address,
          port: message.port,
          token: message.token,
          online: true,
          seen: Date.now(),
        })
        if (message.hello) {
          this.announce(false)
        }
      } catch {}
    })
    await new Promise<void>((resolve) => {
      this.udp!.once('listening', resolve)
      this.udp!.once('error', resolve)
      this.udp!.bind(DISCOVERY_PORT)
    })
    try {
      for (const item of interfaces()) {
        try {
          this.udp.addMembership(GROUP, item.address)
        } catch {}
      }
      this.udp.setMulticastTTL(1)
      this.udp.setBroadcast(true)
      this.announce(true)
      this.timer = setInterval(() => this.announce(false), 2000)
    } catch (error) {
      this.error = String(error)
    }
  }
  private announce(hello: boolean, bye = false) {
    const buffer = Buffer.from(
      JSON.stringify({
        app: 'geopress-lan-v1',
        id: this.id,
        port: this.port,
        token: this.token,
        name: this.options.name,
        hello,
        bye,
      }),
    )
    for (const item of interfaces()) {
      try {
        this.udp?.setMulticastInterface(item.address)
        this.udp?.send(buffer, DISCOVERY_PORT, GROUP, () => {})
        const broadcastNumber = (numberIP(item.address) | ~numberIP(item.netmask)) >>> 0
        const broadcast = [24, 16, 8, 0].map((shift) => (broadcastNumber >>> shift) & 255).join('.')
        this.udp?.send(buffer, DISCOVERY_PORT, broadcast, () => {})
      } catch {}
    }
  }
  snapshot(): LanSnapshot {
    const ips = interfaces().map((item) => item.address)
    return {
      self: { id: this.id, name: this.options.name ?? ips[0]?.split('.').at(-1) ?? '本机', ips },
      peers: [...this.peers.values()].map(({ token: _token, seen, ...peer }) => ({
        ...peer,
        online: Date.now() - seen < 8000,
      })),
      messages: this.messages,
      transfers: this.transfers,
      error: this.error,
    }
  }
  /** Test helper also used by an explicit direct-connect address, never by remote requests. */
  async connect(ip: string, port: number) {
    if (
      !trusted(ip, !!this.options.loopback) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error('仅支持当前局域网地址')
    }
    const response = await fetch(`http://${ip}:${port}/hello`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      throw new Error('用户不在线')
    }
    const info = (await response.json()) as { id: string; token: string; name?: string }
    this.peers.set(info.id, {
      id: info.id,
      token: info.token,
      ip,
      port,
      name: info.name ?? ip.split('.').at(-1)!,
      online: true,
      seen: Date.now(),
    })
    await this.post(info.id, 'presence', {
      id: this.id,
      port: this.port,
      token: this.token,
      name: this.options.name,
    })
    return info.id
  }
  endpoint() {
    return this.port
  }
  private peer(id: string) {
    const peer = this.peers.get(id)
    if (!peer || Date.now() - peer.seen >= 8000) {
      throw new Error('对方已离线，无法传输')
    }
    return peer
  }
  private async post(peerId: string, route: string, body: unknown) {
    const peer = this.peer(peerId)
    const response = await fetch(`http://${peer.ip}:${peer.port}/${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${peer.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      throw new Error(await response.text())
    }
    peer.seen = Date.now()
    return response.json()
  }
  private persist() {
    const text = JSON.stringify({ messages: this.messages, transfers: this.transfers })
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.dataDirectory, 'history.json')
        await writeFile(file + '.tmp', text)
        await rename(file + '.tmp', file)
      })
    return this.saving
  }
  async sendText(peerId: string, text: string) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 512 * 1024) {
      throw new Error('文本为空或过长')
    }
    const message = { id: randomUUID(), text, time: new Date().toISOString() }
    await this.post(peerId, 'text', { ...message, from: this.id })
    this.messages.push({ ...message, peerId, direction: 'out' })
    await this.persist()
  }
  async offer(peerId: string, paths: string[]) {
    this.peer(peerId)
    if (!Array.isArray(paths) || !paths.length) {
      throw new Error('请选择文件或文件夹')
    }
    const entries: Entry[] = []
    const walk = async (source: string, name: string) => {
      safeRelative(name)
      const info = await lstat(source)
      if (info.isSymbolicLink()) {
        throw new Error('暂不传输符号链接：' + name)
      }
      if (info.isDirectory()) {
        entries.push({ name, size: 0, directory: true })
        for (const child of await readdir(source)) {
          await walk(path.join(source, child), name + '/' + child)
        }
      } else if (info.isFile()) {
        if (!Number.isSafeInteger(info.size)) {
          throw new Error('文件大小超出文件系统支持范围')
        }
        entries.push({ name, size: info.size, directory: false, source, mtime: info.mtimeMs })
      } else {
        throw new Error('不支持此文件类型：' + name)
      }
    }
    const roots = new Set<string>()
    for (const source of paths) {
      if (!path.isAbsolute(source)) {
        throw new Error('文件路径无效')
      }
      const name = cleanName(path.basename(source))
      if (roots.has(name.toLowerCase())) {
        throw new Error('选择项存在同名文件，请分别发送')
      }
      roots.add(name.toLowerCase())
      await walk(source, name)
    }
    const id = randomUUID()
    const size = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (!Number.isSafeInteger(size)) {
      throw new Error('总大小超出文件系统支持范围')
    }
    const transfer: LanTransfer = {
      id,
      peerId,
      direction: 'out',
      name: paths.length === 1 ? path.basename(paths[0]) : `${paths.length} 个项目`,
      files: entries.filter((entry) => !entry.directory).length,
      size,
      received: 0,
      status: 'offered',
      time: new Date().toISOString(),
    }
    this.outgoing.set(id, entries)
    this.transfers.push(transfer)
    try {
      await this.post(peerId, 'offer', { ...transfer, from: this.id })
      await this.persist()
    } catch (error) {
      transfer.status = 'failed'
      transfer.error = String(error)
      await this.persist()
      throw error
    }
  }
  async accept(id: string, directory: string) {
    const transfer = this.transfers.find((t) => t.id === id && t.direction === 'in')
    if (!transfer || !['offered', 'failed'].includes(transfer.status)) {
      throw new Error('传输状态无效')
    }
    this.peer(transfer.peerId)
    if (!path.isAbsolute(directory)) {
      throw new Error('接收目录无效')
    }
    if (this.controllers.size >= 2) {
      throw new Error('已有两个接收任务，请等待完成后再接收')
    }
    const controller = new AbortController()
    this.controllers.set(id, controller)
    transfer.status = 'transferring'
    transfer.error = ''
    await this.persist()
    const work = this.receive(transfer, directory, controller)
      .catch((error) => {
        this.error = '保存聊天记录失败：' + String(error)
      })
      .finally(() => {
        this.controllers.delete(id)
        this.receiving.delete(work)
      })
    this.receiving.add(work)
  }
  previewPath(id: string): string | undefined {
    const transfer = this.transfers.find((t) => t.id === id)
    if (!transfer || transfer.files !== 1 || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(transfer.name)) {
      return
    }
    if (transfer.direction === 'out') {
      return this.outgoing.get(id)?.find((entry) => !entry.directory)?.source
    }
    if (transfer.status === 'done' && transfer.path) {
      return path.join(transfer.path, transfer.name)
    }
  }
  async cancel(id: string) {
    const transfer = this.transfers.find((t) => t.id === id)
    if (!transfer || ['done', 'cancelled', 'rejected'].includes(transfer.status)) {
      return
    }
    transfer.status =
      transfer.status === 'offered' && transfer.direction === 'in' ? 'rejected' : 'cancelled'
    this.controllers.get(id)?.abort()
    await this.post(transfer.peerId, 'progress', {
      id,
      status: transfer.status,
      received: transfer.received,
    }).catch(() => {})
    await this.persist()
  }
  private async receive(transfer: LanTransfer, directory: string, controller: AbortController) {
    const peer = this.peer(transfer.peerId)
    const headers = { Authorization: `Bearer ${peer.token}` }
    const base = `http://${peer.ip}:${peer.port}`
    const staging = path.join(directory, '.geopress-' + transfer.id)
    const contents = path.join(staging, 'data')
    const parts = path.join(staging, 'parts')
    let lastUpdate = 0
    const started = Date.now()
    const initial = transfer.received
    try {
      const manifest = await fetch(`${base}/manifest/${transfer.id}`, {
        headers,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      })
      if (!manifest.ok) {
        throw new Error('发送方已离线或文件已失效')
      }
      const entries = (await manifest.json()) as Entry[]
      if (!Array.isArray(entries)) {
        throw new Error('文件列表无效')
      }
      const names = new Set<string>()
      let size = 0
      for (const entry of entries) {
        safeRelative(entry.name)
        if (
          names.has(entry.name.toLowerCase()) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          typeof entry.directory !== 'boolean'
        ) {
          throw new Error('文件列表无效或名称冲突')
        }
        names.add(entry.name.toLowerCase())
        size += entry.size
      }
      if (size !== transfer.size) {
        throw new Error('文件大小不匹配')
      }
      await mkdir(contents, { recursive: true })
      await mkdir(parts, { recursive: true })
      transfer.path = staging
      transfer.received = 0
      await this.post(peer.id, 'progress', { id: transfer.id, status: 'transferring', received: 0 })
      // A bounded queue: at most two files and 8 MiB of chunk buffers in memory.
      let next = 0
      const worker = async () => {
        while (next < entries.length) {
          const index = next++
          const entry = entries[index]
          const output = path.join(contents, safeRelative(entry.name))
          if (entry.directory) {
            await mkdir(output, { recursive: true })
            continue
          }
          await mkdir(path.dirname(output), { recursive: true })
          try {
            const completed = await lstat(output)
            if (completed.isFile() && completed.size === entry.size) {
              transfer.received += entry.size
              continue
            }
            throw new Error('接收目录存在不匹配的文件')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error
            }
          }
          const partial = path.join(parts, String(index))
          let file
          try {
            file = await open(partial, 'r+')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error
            }
            file = await open(partial, 'wx')
          }
          try {
            let offset = (await file.stat()).size
            if (offset > entry.size) {
              await file.truncate(0)
              offset = 0
            }
            transfer.received += offset
            while (offset < entry.size) {
              controller.signal.throwIfAborted()
              const length = Math.min(CHUNK, entry.size - offset)
              let chunk: Buffer | undefined
              for (let attempt = 0; attempt < 4; attempt++) {
                try {
                  const response = await fetch(
                    `${base}/chunk/${transfer.id}/${index}?offset=${offset}&length=${length}`,
                    {
                      headers,
                      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
                    },
                  )
                  if (!response.ok) {
                    throw new Error(await response.text())
                  }
                  chunk = Buffer.from(await response.arrayBuffer())
                  if (
                    chunk.length !== length ||
                    createHash('sha256').update(chunk).digest('hex') !==
                      response.headers.get('x-chunk-sha256')
                  ) {
                    throw new Error('分块完整性校验失败')
                  }
                  break
                } catch (error) {
                  chunk = undefined
                  controller.signal.throwIfAborted()
                  if (attempt === 3) {
                    throw error
                  }
                  await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
                }
              }
              if (!chunk) {
                throw new Error('无法接收数据')
              }
              let written = 0
              while (written < chunk.length) {
                const result = await file.write(
                  chunk,
                  written,
                  chunk.length - written,
                  offset + written,
                )
                if (!result.bytesWritten) {
                  throw new Error('磁盘写入失败')
                }
                written += result.bytesWritten
              }
              offset += chunk.length
              transfer.received += chunk.length
              peer.seen = Date.now()
              transfer.speed =
                (transfer.received - initial) / Math.max(1, (Date.now() - started) / 1000)
              if (Date.now() - lastUpdate > 1000) {
                lastUpdate = Date.now()
                await this.post(peer.id, 'progress', {
                  id: transfer.id,
                  status: 'transferring',
                  received: transfer.received,
                })
                await this.persist()
              }
            }
            await file.sync()
          } finally {
            await file.close()
          }
          await rename(partial, output)
        }
      }
      const results = await Promise.allSettled(
        [worker(), worker()].map((work) =>
          work.catch((error) => {
            controller.abort()
            throw error
          }),
        ),
      )
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        throw failed.reason
      }
      controller.signal.throwIfAborted()
      const destination = path.join(
        directory,
        cleanName(transfer.name) + '-' + transfer.id.slice(0, 8),
      )
      // Never replace any existing user path, including an earlier completed transfer.
      try {
        await lstat(destination)
        throw new Error('接收目标已存在')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      await rename(contents, destination)
      await rm(staging, { recursive: true, force: true })
      transfer.path = destination
      transfer.received = transfer.size
      transfer.status = 'done'
      transfer.speed = undefined
      await this.post(peer.id, 'progress', {
        id: transfer.id,
        status: 'done',
        received: transfer.size,
      }).catch(() => {})
    } catch (error) {
      controller.abort()
      if (transfer.status !== 'cancelled') {
        transfer.status = 'failed'
      }
      transfer.error = String(error)
      transfer.speed = undefined
      await this.post(peer.id, 'progress', {
        id: transfer.id,
        status: transfer.status,
        received: transfer.received,
      }).catch(() => {})
    } finally {
      await this.persist()
    }
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const ip = ipv4(req.socket.remoteAddress ?? '')
      if (!trusted(ip, !!this.options.loopback) || req.headers.origin) {
        res.writeHead(403).end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/hello') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ id: this.id, token: this.token, name: this.options.name }))
        return
      }
      const auth = Buffer.from(req.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${this.token}`)
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        res.writeHead(403).end()
        return
      }
      if (req.method === 'POST') {
        const body = await jsonBody(req)
        if (url.pathname === '/presence') {
          if (
            typeof body.id !== 'string' ||
            !/^[a-f0-9]{64}$/.test(body.token) ||
            !Number.isInteger(body.port) ||
            body.port < 1 ||
            body.port > 65535
          ) {
            throw new Error('用户信息无效')
          }
          this.peers.set(body.id, {
            id: body.id,
            token: body.token,
            ip,
            port: body.port,
            name: typeof body.name === 'string' ? body.name.slice(0, 32) : ip.split('.').at(-1)!,
            online: true,
            seen: Date.now(),
          })
        } else {
          const peer = [...this.peers.values()].find(
            (p) =>
              p.ip === ip &&
              p.id === (body.from ?? this.transfers.find((t) => t.id === body.id)?.peerId),
          )
          if (!peer) {
            throw new Error('用户未发现')
          }
          peer.seen = Date.now()
          if (url.pathname === '/text') {
            if (
              typeof body.id !== 'string' ||
              typeof body.text !== 'string' ||
              !body.text.trim() ||
              Buffer.byteLength(body.text) > 512 * 1024
            ) {
              throw new Error('消息无效')
            }
            if (!this.messages.some((m) => m.id === body.id)) {
              this.messages.push({
                id: body.id,
                text: body.text,
                time: new Date().toISOString(),
                peerId: peer.id,
                direction: 'in',
              })
            }
          } else if (url.pathname === '/offer') {
            if (
              !/^[a-f0-9-]{36}$/.test(body.id) ||
              !Number.isSafeInteger(body.size) ||
              body.size < 0 ||
              !Number.isInteger(body.files) ||
              body.files < 0
            ) {
              throw new Error('传输请求无效')
            }
            cleanName(body.name)
            if (!this.transfers.some((t) => t.id === body.id)) {
              this.transfers.push({
                id: body.id,
                name: body.name,
                size: body.size,
                files: body.files,
                peerId: peer.id,
                direction: 'in',
                received: 0,
                status: 'offered',
                time: new Date().toISOString(),
              })
            }
          } else if (url.pathname === '/progress') {
            const transfer = this.transfers.find((t) => t.id === body.id && t.peerId === peer.id)
            if (
              !transfer ||
              !['transferring', 'done', 'failed', 'cancelled', 'rejected'].includes(body.status) ||
              !Number.isSafeInteger(body.received) ||
              body.received < 0 ||
              body.received > transfer.size
            ) {
              throw new Error('传输进度无效')
            }
            if (!['done', 'cancelled', 'rejected'].includes(transfer.status)) {
              transfer.status = body.status
              transfer.received = body.received
              if (['cancelled', 'rejected'].includes(body.status)) {
                this.controllers.get(body.id)?.abort()
              }
            }
          } else {
            res.writeHead(404).end()
            return
          }
        }
        await this.persist()
        res.setHeader('Content-Type', 'application/json')
        res.end('{}')
        return
      }
      const segments = url.pathname.split('/')
      const transfer = this.transfers.find((t) => t.id === segments[2] && t.direction === 'out')
      const peer = transfer && this.peers.get(transfer.peerId)
      if (
        !transfer ||
        !peer ||
        peer.ip !== ip ||
        ['cancelled', 'rejected', 'done'].includes(transfer.status)
      ) {
        throw new Error('传输已失效')
      }
      peer.seen = Date.now()
      const entries = this.outgoing.get(transfer.id)
      if (!entries) {
        throw new Error('源文件列表已失效')
      }
      if (req.method === 'GET' && segments[1] === 'manifest') {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify(entries.map(({ name, size, directory }) => ({ name, size, directory }))),
        )
        return
      }
      if (req.method === 'GET' && segments[1] === 'chunk') {
        const index = Number(segments[3])
        const offset = Number(url.searchParams.get('offset'))
        const length = Number(url.searchParams.get('length'))
        const entry = entries[index]
        if (
          !Number.isInteger(index) ||
          !entry?.source ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(length) ||
          length <= 0 ||
          length > CHUNK ||
          offset + length > entry.size
        ) {
          throw new Error('分块参数无效')
        }
        const file = await open(entry.source, 'r')
        try {
          const info = await file.stat()
          if (info.size !== entry.size || info.mtimeMs !== entry.mtime) {
            throw new Error('发送期间源文件发生变化，请重新发送')
          }
          const buffer = Buffer.allocUnsafe(length)
          let read = 0
          while (read < length) {
            const result = await file.read(buffer, read, length - read, offset + read)
            if (!result.bytesRead) {
              throw new Error('源文件读取失败')
            }
            read += result.bytesRead
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': length,
            'X-Chunk-SHA256': createHash('sha256').update(buffer).digest('hex'),
          })
          res.end(buffer)
        } finally {
          await file.close()
        }
        return
      }
      res.writeHead(404).end()
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(400)
      }
      res.end(String(error))
    }
  }
  async close() {
    if (this.closed) {
      return
    }
    this.closed = true
    clearInterval(this.timer)
    this.announce(false, true)
    for (const controller of this.controllers.values()) {
      controller.abort()
    }
    this.udp?.close()
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    )
    await Promise.allSettled([...this.receiving])
    await this.saving.catch(() => {})
  }
}
