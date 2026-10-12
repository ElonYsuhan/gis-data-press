import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { LanChat } from '../server/lan'
async function waitFor(check: () => boolean) {
  const end = Date.now() + 15000
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('传输未在测试期限内完成')
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}
test('LAN peers exchange text and a multi-chunk folder with retry, empty directories, and no overwrite', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geopress-lan-'))
  const sender = new LanChat(path.join(root, 'sender'), { discovery: false, loopback: true })
  const receiver = new LanChat(path.join(root, 'receiver'), { discovery: false, loopback: true })
  const originalFetch = globalThis.fetch
  try {
    await sender.start()
    await receiver.start()
    const peer = await sender.connect('127.0.0.1', receiver.endpoint())
    assert.equal(sender.snapshot().peers[0].name, '1')
    await sender.sendText(peer, '你好，局域网\n第二行')
    assert.equal(receiver.snapshot().messages[0].text, '你好，局域网\n第二行')
    const source = path.join(root, '数据包')
    await mkdir(path.join(source, '空文件夹'), { recursive: true })
    const large = Buffer.alloc(13 * 1024 * 1024 + 37, 117)
    await writeFile(path.join(source, 'large.zip'), large)
    await writeFile(path.join(source, '说明.txt'), '目录结构保留')
    await writeFile(path.join(source, 'empty'), '')
    await writeFile(path.join(source, 'empty.geopress-part'), '名称不会与临时文件冲突')
    const destination = path.join(root, 'received')
    await mkdir(destination)
    await writeFile(path.join(destination, 'existing.txt'), '保留')
    await sender.offer(peer, [source])
    const incoming = receiver.snapshot().transfers[0]
    assert.equal(incoming.status, 'offered')
    let retries = 0
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes('/chunk/') && !retries++) {
        throw new Error('模拟瞬时断网')
      }
      return originalFetch(...args)
    }) as typeof fetch
    await receiver.accept(incoming.id, destination)
    await waitFor(() => ['done', 'failed'].includes(receiver.snapshot().transfers[0].status))
    const completed = receiver.snapshot().transfers[0]
    assert.equal(completed.status, 'done', completed.error)
    assert.ok(retries > 1)
    assert.equal(sender.snapshot().transfers[0].status, 'done')
    const copied = await readFile(path.join(completed.path!, '数据包/large.zip'))
    assert.equal(
      createHash('sha256').update(copied).digest('hex'),
      createHash('sha256').update(large).digest('hex'),
    )
    assert.equal(await readFile(path.join(destination, 'existing.txt'), 'utf8'), '保留')
    assert.deepEqual(await readdir(path.join(completed.path!, '数据包/空文件夹')), [])
    assert.equal(
      await readFile(path.join(completed.path!, '数据包/empty.geopress-part'), 'utf8'),
      '名称不会与临时文件冲突',
    )
    await receiver.close()
    await assert.rejects(sender.sendText(peer, '离线不发送'))
    assert.equal(sender.snapshot().messages.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    await sender.close()
    await receiver.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('LAN receiver rejects path traversal manifests before writing any files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geopress-lan-path-'))
  const sender = new LanChat(path.join(root, 'sender'), { discovery: false, loopback: true })
  const receiver = new LanChat(path.join(root, 'receiver'), { discovery: false, loopback: true })
  const originalFetch = globalThis.fetch
  try {
    await sender.start()
    await receiver.start()
    const peer = await sender.connect('127.0.0.1', receiver.endpoint())
    const file = path.join(root, 'normal.txt')
    await writeFile(file, 'ok')
    await sender.offer(peer, [file])
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes('/manifest/')) {
        return new Response(
          JSON.stringify([{ name: '../escape.txt', size: 2, directory: false }]),
          { headers: { 'Content-Type': 'application/json' } },
        )
      }
      return originalFetch(...args)
    }) as typeof fetch
    const dest = path.join(root, 'received')
    await mkdir(dest)
    await receiver.accept(receiver.snapshot().transfers[0].id, dest)
    await waitFor(() => receiver.snapshot().transfers[0].status === 'failed')
    assert.deepEqual(await readdir(dest), [])
  } finally {
    globalThis.fetch = originalFetch
    await sender.close()
    await receiver.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('files over 4 GiB are offered without a size cap, and rejection does not write data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geopress-lan-large-'))
  const sender = new LanChat(path.join(root, 'sender'), { discovery: false, loopback: true })
  const receiver = new LanChat(path.join(root, 'receiver'), { discovery: false, loopback: true })
  try {
    await sender.start()
    await receiver.start()
    const peer = await sender.connect('127.0.0.1', receiver.endpoint())
    const { open } = await import('node:fs/promises')
    const file = await open(path.join(root, 'large.zip'), 'wx')
    await file.truncate(5 * 1024 ** 3)
    await file.close()
    await sender.offer(peer, [path.join(root, 'large.zip')])
    const transfer = receiver.snapshot().transfers[0]
    assert.equal(transfer.size, 5 * 1024 ** 3)
    await receiver.cancel(transfer.id)
    assert.equal(receiver.snapshot().transfers[0].status, 'rejected')
    assert.equal(sender.snapshot().transfers[0].status, 'rejected')
    assert.equal(transfer.received, 0)
  } finally {
    await sender.close()
    await receiver.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed transfer resumes from verified chunks in the same destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geopress-lan-resume-'))
  const sender = new LanChat(path.join(root, 'sender'), { discovery: false, loopback: true })
  const receiver = new LanChat(path.join(root, 'receiver'), { discovery: false, loopback: true })
  const originalFetch = globalThis.fetch
  try {
    await sender.start()
    await receiver.start()
    const peer = await sender.connect('127.0.0.1', receiver.endpoint())
    const source = path.join(root, 'resume.zip')
    const bytes = Buffer.alloc(11 * 1024 * 1024, 71)
    await writeFile(source, bytes)
    const dest = path.join(root, 'received')
    await mkdir(dest)
    await sender.offer(peer, [source])
    const transfer = receiver.snapshot().transfers[0]
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0])
      if (url.includes('/chunk/') && !url.includes('offset=0&')) {
        throw new Error('模拟持续断网')
      }
      return originalFetch(...args)
    }) as typeof fetch
    await receiver.accept(transfer.id, dest)
    await waitFor(() => transfer.status === 'failed')
    assert.equal(transfer.received, 4 * 1024 * 1024)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const requested: number[] = []
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0])
      if (url.includes('/chunk/')) {
        requested.push(Number(new URL(url).searchParams.get('offset')))
      }
      return originalFetch(...args)
    }) as typeof fetch
    await receiver.accept(transfer.id, dest)
    await waitFor(() => transfer.status === 'done' || transfer.status === 'failed')
    assert.equal(transfer.status, 'done', transfer.error)
    assert.equal(requested[0], 4 * 1024 * 1024)
    assert.deepEqual(await readFile(path.join(transfer.path!, 'resume.zip')), bytes)
  } finally {
    globalThis.fetch = originalFetch
    await sender.close()
    await receiver.close()
    await rm(root, { recursive: true, force: true })
  }
})
