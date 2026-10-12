import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { LanChat } from '../server/lan'
// @ts-expect-error helper is an existing JavaScript cleanup script
import { cleanupTestService } from './cleanup-test-service.mjs'
const root = await mkdtemp(path.join(os.tmpdir(), 'geopress-chat-ui-'))
const remote = new LanChat(path.join(root, 'remote'))
await remote.start()
const app = await electron.launch({
  args: [path.resolve('.'), '--user-data-dir=' + path.join(root, 'desktop')],
  env: { ...process.env, GEOPRESS_STATE: path.join(root, 'app') },
})
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '局域网聊天', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.lan-peer-list button') !== null, {
    timeout: 20000,
  })
  await page.locator(`[data-peer-id="${remote.id}"]`).click({ timeout: 20000 })
  await page.getByRole('textbox', { name: '输入聊天消息' }).fill('局域网消息测试')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByText('局域网消息测试', { exact: true }).waitFor()
  assert.equal(remote.snapshot().messages.at(-1)?.text, '局域网消息测试')
  const targetPeer = remote.snapshot().messages.at(-1)!.peerId
  await remote.sendText(targetPeer, '回复已收到')
  await page.getByText('回复已收到', { exact: true }).waitFor()
  const png = path.join(root, '示例.png')
  await writeFile(png, await readFile('resources/icons/icon-512.png'))
  await remote.offer(targetPeer, [png])
  await page.getByText('示例.png', { exact: true }).waitFor()
  const received = path.join(root, 'received')
  await mkdir(received)
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [directory],
    })) as typeof dialog.showOpenDialog
  }, received)
  await page.getByRole('button', { name: '接收', exact: true }).click()
  await page.getByText('已完成', { exact: true }).waitFor({ timeout: 15000 })
  await page.locator('.lan-image-preview').waitFor()
  const zip = path.join(root, '测试.zip')
  await writeFile(zip, 'opaque archive bytes')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [file],
    })) as typeof dialog.showOpenDialog
  }, zip)
  await page.getByRole('button', { name: '文件 / 压缩包', exact: true }).click()
  await page.getByText('测试.zip', { exact: true }).waitFor()
  const transfer = remote.snapshot().transfers.find((t) => t.name === '测试.zip')!
  await remote.accept(transfer.id, received)
  await page.getByText('已完成', { exact: true }).nth(1).waitFor({ timeout: 15000 })
  const copy = remote.snapshot().transfers.find((t) => t.id === transfer.id)!
  assert.equal(await readFile(path.join(copy.path!, '测试.zip'), 'utf8'), 'opaque archive bytes')
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/lan-chat.png' })
  console.log(
    'LAN automatic discovery, bidirectional text, image preview and archive transfer passed',
  )
} catch (error) {
  const page = await app.firstWindow()
  console.log(await page.locator('.lan-error').allTextContents())
  console.log(JSON.stringify(remote.snapshot()))
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/lan-chat-failure.png' })
  throw error
} finally {
  await app.close()
  await remote.close()
  await cleanupTestService(path.join(root, 'app'))
  await rm(root, { recursive: true, force: true })
}
