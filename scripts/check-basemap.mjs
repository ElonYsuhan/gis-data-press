import { cleanupTestService } from './cleanup-test-service.mjs'
import { _electron as electron } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const state = await mkdtemp(path.join(os.tmpdir(), 'gis-basemap-'))
const probe = createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const app = await electron.launch({
  executablePath: path.resolve('release/mac-arm64/GeoPress.app/Contents/MacOS/GeoPress'),
  env: { ...process.env, GEOPRESS_STATE: state },
})
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '登记资源目录' }).first().waitFor()
  const external = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (
      u.protocol.startsWith('http') &&
      u.hostname !== '127.0.0.1' &&
      u.hostname !== 'tile.openstreetmap.org'
    ) {
      external.push(r.url())
    }
  })
  await page.evaluate(
    async ({ port, directory }) => {
      const s = await window.gis.snapshot()
      await window.gis.saveSettings({ ...s.settings, port })
      await window.gis.savePublication({
        name: '地形底图验收',
        directory,
        mount: '/terrain/',
        kind: 'terrain',
      })
      await window.gis.server('start')
    },
    { port, directory: path.resolve('.test-artifacts/terrain-final') },
  )
  const tile = page.waitForResponse(
    (r) =>
      r.url().startsWith('https://tile.openstreetmap.org/') &&
      r.url().endsWith('.png') &&
      r.status() === 200,
  )
  await page.getByRole('button', { name: '预览 地形底图验收', exact: true }).click()
  await tile
  await page.locator('.cesium-widget canvas').waitFor()
  await page.waitForFunction(() => !document.querySelector('.preview-message'))
  await page.screenshot({ path: 'output/playwright/online-osm-terrain.png' })
  assert.deepEqual(external, [])
  console.log('实际地形预览：OpenStreetMap 在线瓦片成功加载，未请求其他外部地图源')
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
