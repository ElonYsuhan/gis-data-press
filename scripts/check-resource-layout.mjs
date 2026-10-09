import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'
const state = await mkdtemp(path.join(os.tmpdir(), 'geopress-resources-'))
const fixture = path.join(state, 'sample.geojson')
await writeFile(fixture, '{}')
await writeFile(
  path.join(state, 'resources.json'),
  JSON.stringify(
    Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      kind: 'boundary',
      name: `区域 ${i}`,
      path: fixture,
      status: 'ready',
      received: 2,
    })),
  ),
)
const app = await electron.launch({
  executablePath:
    process.env.GEOPRESS_TEST_EXECUTABLE ??
    path.resolve('release/mac-arm64/GeoPress.app/Contents/MacOS/GeoPress'),
  args: ['--user-data-dir=' + path.join(state, 'desktop')],
  env: { ...process.env, GEOPRESS_STATE: state },
})
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '资源下载', exact: true }).click()
  await page
    .getByRole('button', { name: /^打开目录 / })
    .first()
    .waitFor()
  assert.equal(await page.locator('.local-resource-table tbody tr').count(), 10)
  assert.equal(await page.locator('.local-resource-table tbody button').count(), 10)
  assert.equal(await page.locator('.local-resource-table tbody button').first().innerText(), '')
  await page.locator('.local-resource-pagination').getByText('2', { exact: true }).click()
  await page.getByText('区域 10', { exact: true }).waitFor()
  await page.locator('.local-resource-pagination').getByText('1', { exact: true }).click()
  for (const [width, height] of [
    [1440, 940],
    [1080, 720],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    )
    const metrics = await page.evaluate(() => {
      const left = document.querySelector('.acquisition-panel').getBoundingClientRect()
      const right = document.querySelector('.local-resources-panel').getBoundingClientRect()
      const list = document.querySelector('.local-resource-list')
      const status = document.querySelector('.statusbar').getBoundingClientRect()
      return {
        left: left.bottom,
        right: right.bottom,
        status: status.top,
        overflow: list.scrollHeight > list.clientHeight,
        scroll: getComputedStyle(list).overflowY,
        pageScroll: document.documentElement.scrollHeight > innerHeight,
      }
    })
    assert.ok(Math.abs(metrics.left - metrics.right) < 2)
    assert.ok(
      metrics.status - metrics.left < 35 && metrics.left <= metrics.status,
      JSON.stringify(metrics),
    )
    assert.equal(metrics.pageScroll, false)
    assert.equal(metrics.overflow, true)
    assert.equal(metrics.scroll, 'auto')
  }
  console.log('资源两栏高度对齐并延伸到底部；20 条资源分页表格，内部滚动；文件操作仅目录图标。')
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
