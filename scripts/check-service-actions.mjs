/** Verify action labels and SVG geometry in an isolated publishing profile. */
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'

const state = await mkdtemp(path.join(os.tmpdir(), 'geopress-actions-'))
const fixture = path.join(state, 'fixture')
await mkdir(fixture)
await writeFile(
  path.join(fixture, 'image.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZS0AAAAASUVORK5CYII=',
    'base64',
  ),
)
const probe = createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const app = await electron.launch({
  executablePath:
    process.env.GEOPRESS_TEST_EXECUTABLE ??
    path.resolve('release/mac-arm64/GeoPress.app/Contents/MacOS/GeoPress'),
  args: ['--user-data-dir=' + path.join(state, 'desktop')],
  env: { ...process.env, GEOPRESS_STATE: state },
})
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '登记资源目录', exact: true }).first().waitFor()
  await page.evaluate(
    async ({ fixture, port }) => {
      const snapshot = await window.gis.snapshot()
      await window.gis.saveSettings({ ...snapshot.settings, port })
      for (let i = 0; i < 4; i++) {
        await window.gis.savePublication({
          name: '清晰操作 ' + (i + 1),
          directory: fixture,
          mount: '/sample-' + i + '/',
          kind: 'image',
        })
      }
      await window.gis.server('start')
    },
    { fixture, port },
  )
  await page.getByRole('button', { name: '检查目录', exact: true }).click()
  await page.getByRole('button', { name: '预览 清晰操作 1', exact: true }).waitFor()
  for (const width of [1440, 1080]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 940),
      width,
    )
    const metrics = await page
      .locator('.row-actions')
      .first()
      .locator('button')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const icon = button.querySelector('svg').getBoundingClientRect()
          const rect = button.getBoundingClientRect()
          return {
            label: button.textContent.trim(),
            iconWidth: icon.width,
            iconHeight: icon.height,
            width: rect.width,
            height: rect.height,
            color: getComputedStyle(button).color,
          }
        }),
      )
    assert.deepEqual(
      metrics.map((metric) => metric.label),
      ['', ''],
    )
    for (const metric of metrics) {
      assert.ok(metric.iconWidth >= 16 && metric.iconHeight >= 16, JSON.stringify(metric))
      assert.ok(metric.height >= 32, JSON.stringify(metric))
    }
    await mkdir('output/playwright', { recursive: true })
    await page.screenshot({
      path: `output/playwright/service-actions-${width}.png`,
      fullPage: true,
    })
  }
  await page.getByRole('button', { name: '更多操作 清晰操作 1', exact: true }).click()
  for (const label of ['复制', '停用', '打开位置', '删除']) {
    await page.locator('.n-dropdown-menu').getByText(label, { exact: true }).waitFor()
  }
  await page.locator('.n-dropdown-menu').getByText('删除', { exact: true }).click()
  await page.getByRole('dialog', { name: '确认移除服务映射？', exact: true }).waitFor()
  const close = page.getByRole('button', { name: '关闭移除确认', exact: true })
  await close.click({ trial: true })
  await page.waitForFunction(
    () => {
      const icon = document.querySelector('[aria-label="关闭移除确认"] svg')
      return icon && icon.getBoundingClientRect().width >= 16
    },
    null,
    { timeout: 5000 },
  )
  await close.click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '停止', exact: true }).click()
  const alertClose = page.getByRole('button', { name: '关闭操作提示', exact: true })
  await alertClose.waitFor()
  const closeMetrics = await alertClose.evaluate((button) => {
    const rect = button.getBoundingClientRect()
    const icon = button.querySelector('svg').getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      iconWidth: icon.width,
      iconHeight: icon.height,
    }
  })
  assert.equal(closeMetrics.width, 28)
  assert.equal(closeMetrics.height, 28)
  assert.equal(closeMetrics.iconWidth, 16)
  assert.equal(closeMetrics.iconHeight, 16)
  await alertClose.hover()
  await page.screenshot({ path: 'output/playwright/alert-close.png' })
  await alertClose.click()
  await alertClose.waitFor({ state: 'hidden' })
  console.log('Service labels, uncompressed icons, 1440/1080 layouts and dialog close icon passed')
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
