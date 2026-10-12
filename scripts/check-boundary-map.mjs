import { _electron as electron } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'
const state = await mkdtemp(path.join(os.tmpdir(), 'geopress-map-'))
const app = await electron.launch({
  executablePath: process.env.GEOPRESS_TEST_EXECUTABLE,
  args: [path.resolve('.'), '--user-data-dir=' + path.join(state, 'desktop')],
  env: { ...process.env, GEOPRESS_STATE: state },
})
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '资源下载', exact: true }).click()
  await page.getByText('点击地图选择行政区', { exact: true }).waitFor({ timeout: 60000 })
  assert.equal(await page.locator('.boundary-map canvas').count(), 1)
  const requests = []
  page.on('request', (request) => {
    if (request.url().includes('areas_v3/bound/')) {requests.push(request.url())}
  })
  async function select(code, name) {
    await page.getByRole('textbox', { name: '地名或行政区代码' }).fill(code)
    await page.getByRole('button', { name: '检索', exact: true }).click()
    await page.locator('.boundary-search-matches button').filter({ hasText: name }).click()
    await ready(name)
  }
  async function ready(name) {
    console.log('Waiting for', name)
    await page
      .locator('.boundary-map-toolbar span')
      .getByText(name, { exact: true })
      .waitFor({ timeout: 60000 })
    await page
      .getByText('正在加载边界…', { exact: true })
      .waitFor({ state: 'hidden', timeout: 60000 })
  }
  async function outside() {
    const canvas = await page.locator('.boundary-map canvas').boundingBox()
    await page.mouse.click(canvas.x + canvas.width - 12, canvas.y + canvas.height - 40)
  }
  await select('610000', '陕西省')
  assert.equal(await page.getByRole('button', { name: '进入下级', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '上一级', exact: true }).count(), 0)
  await select('610100', '西安市')
  await select('610102', '新城区')
  await outside()
  await ready('西安市')
  await outside()
  await ready('陕西省')
  await outside()
  await ready('全国')
  assert.equal(requests.filter((url) => url.endsWith('610000_full.json')).length, 1)
  assert.equal(requests.filter((url) => url.endsWith('610100_full.json')).length, 1)
  await select('610000', '陕西省')
  const canvas = await page.locator('.boundary-map canvas').boundingBox()
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  await page.mouse.wheel(0, 3000)
  await page.waitForTimeout(1200)
  assert.equal(await page.locator('.boundary-map-toolbar span').innerText(), '陕西省')
  await page.screenshot({ path: 'output/playwright/boundary-map.png' })
  console.log('Boundary map district/city/province outside clicks and cached return passed')
} catch (error) {
  const page = await app.firstWindow()
  await page.screenshot({ path: 'output/playwright/boundary-map-failure.png' })
  throw error
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
