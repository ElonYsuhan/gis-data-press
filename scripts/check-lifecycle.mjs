import { cleanupTestService } from './cleanup-test-service.mjs'
import { _electron as electron } from 'playwright'
import { mkdtemp, rm, readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const state = await mkdtemp(path.join(os.tmpdir(), 'gis-lifecycle-'))
const probe = createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const executablePath = path.resolve('release/mac-arm64/GeoPress.app/Contents/MacOS/GeoPress')
let app
let endpoint
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) {
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('状态变化超时')
}

async function launch() {
  return electron.launch({
    executablePath,
    args: ['--user-data-dir=' + path.join(state, 'desktop')],
    env: { ...process.env, GEOPRESS_STATE: state },
  })
}
try {
  const directory = path.join(state, 'fixture')
  await mkdir(directory)
  await writeFile(path.join(directory, 'icon.png'), 'test')
  app = await launch()
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '在默认浏览器打开管理界面' }).waitFor()
  const management = new URL(page.url())
  assert.equal(management.hostname, '127.0.0.1')
  await page.evaluate(
    async ({ port, directory }) => {
      const s = await window.gis.snapshot()
      await window.gis.saveSettings({ ...s.settings, port })
      await window.gis.savePublication({
        name: '常驻验收',
        directory,
        mount: '/persistent/',
        kind: 'image',
      })
      await window.gis.server('start')
    },
    { port, directory },
  )
  endpoint = JSON.parse(await readFile(path.join(state, 'service.json'), 'utf8'))
  const resource = `http://127.0.0.1:${port}/persistent/icon.png`
  assert.equal((await fetch(resource)).status, 200)
  const exited = new Promise((resolve) => app.process().once('exit', resolve))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await exited
  await assert.rejects(fetch(management.origin))
  assert.equal((await fetch(resource)).status, 200)
  await rename(path.join(directory, 'icon.png'), path.join(directory, 'icon.disabled'))
  await waitFor(async () => (await fetch(resource)).status === 503)
  await rename(path.join(directory, 'icon.disabled'), path.join(directory, 'icon.png'))
  await waitFor(async () => (await fetch(resource)).status === 200)
  app = await launch()
  const reopened = await app.firstWindow()
  await reopened.getByRole('button', { name: '停止', exact: true }).waitFor()
  assert.equal(
    JSON.parse(await readFile(path.join(state, 'service.json'), 'utf8')).pid,
    endpoint.pid,
  )
  const nginxPid = (await readFile(path.join(state, 'nginx', 'nginx.pid'), 'utf8')).trim()
  await app.close()
  process.kill(endpoint.pid, 'SIGTERM')
  await waitFor(async () => {
    try {
      process.kill(endpoint.pid, 0)
      return false
    } catch {
      return true
    }
  })
  assert.equal((await fetch(resource)).status, 200)
  app = await launch()
  const recovered = await app.firstWindow()
  await recovered.getByRole('button', { name: '停止', exact: true }).waitFor()
  const previousPid = endpoint.pid
  endpoint = JSON.parse(await readFile(path.join(state, 'service.json'), 'utf8'))
  assert.notEqual(endpoint.pid, previousPid)
  assert.equal((await readFile(path.join(state, 'nginx', 'nginx.pid'), 'utf8')).trim(), nginxPid)
  await recovered.evaluate(() => window.gis.server('stop'))
  await waitFor(async () => {
    try {
      await fetch(resource)
      return false
    } catch {
      return true
    }
  })
  console.log(
    '关闭窗口：管理服务关闭，GIS 继续200；后台失效503/恢复200；重开复用同一后台；后台重启接管原Nginx；手动停止GIS成功',
  )
} finally {
  await app?.close().catch(() => {})
  if (!endpoint) {
    try {
      endpoint = JSON.parse(await readFile(path.join(state, 'service.json'), 'utf8'))
    } catch {}
  }
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
