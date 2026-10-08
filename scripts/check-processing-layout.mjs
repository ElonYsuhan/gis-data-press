import { cleanupTestService } from './cleanup-test-service.mjs'
import { _electron as electron } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const state = await mkdtemp(path.join(os.tmpdir(), 'gis-layout-'))
const app = await electron.launch({
  executablePath:
    process.env.GEOPRESS_TEST_EXECUTABLE ??
    path.resolve('release/mac-arm64/GeoPress.app/Contents/MacOS/GeoPress'),
  args: ['--user-data-dir=' + path.join(state, 'desktop')],
  env: { ...process.env, GEOPRESS_STATE: state },
})
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.getByRole('button', { name: '数据处理', exact: true }).click()
  for (const [width, height] of [
    [1440, 940],
    [1280, 800],
    [1080, 720],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()[0].setSize(width, height),
      { width, height },
    )
    for (const kind of ['影像切片', '地形切片', 'OSGB 转 3D Tiles']) {
      await page.getByRole('radio', { name: new RegExp(kind) }).check()
      const metrics = await page.evaluate(() => {
        const content = document.querySelector('.content')
        const form = document.querySelector('.processing-form')
        const button = form.querySelector('.process-actions>.primary')
        const bounds = button.getBoundingClientRect()
        return {
          height: innerHeight,
          documentScroll: document.documentElement.scrollHeight > innerHeight,
          contentScroll: content.scrollHeight > content.clientHeight + 1,
          formOverflow: form.scrollHeight > form.clientHeight + 1,
          formOverflowY: getComputedStyle(form).overflowY,
          formHeight: form.clientHeight,
          formScroll: form.scrollHeight,
          formBottom: form.getBoundingClientRect().bottom,
          buttonBottom: bounds.bottom,
          buttonTop: bounds.top,
        }
      })
      assert.equal(metrics.documentScroll, false, JSON.stringify({ width, height, kind, metrics }))
      assert.equal(metrics.contentScroll, false, JSON.stringify({ width, height, kind, metrics }))
      if (metrics.formOverflow) {
        assert.equal(
          metrics.formOverflowY,
          'auto',
          JSON.stringify({ width, height, kind, metrics }),
        )
      }
      assert.ok(metrics.buttonBottom <= metrics.height && metrics.buttonTop > 0)
    }
  }
  await page.getByRole('radio', { name: /影像切片/ }).check()
  await page.getByRole('button', { name: '高级参数', exact: true }).click()
  await page.getByLabel('源坐标系（可选）').fill('EPSG:4490')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.getByText('2 个请求并行 · EPSG:4490', { exact: true }).waitFor()
  await page.getByLabel('输入 TIFF / VRT 文件').fill('/does-not-exist.tif')
  await page.getByRole('button', { name: '读取数据元信息' }).click()
  await page.getByRole('alert').waitFor()
  assert.ok(await page.getByRole('button', { name: '提交加工任务', exact: true }).isVisible())
  await page.getByRole('button', { name: '关闭错误提示' }).click()
  await page.getByLabel('输入 TIFF / VRT 文件').fill('')
  assert.equal(await page.locator('.fusion-source').count(), 0)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940))
  await page.locator('.processing-form').evaluate((form) => {
    form.scrollTop = 0
  })
  await page.screenshot({ path: 'output/playwright/processing-redesigned.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log(
    '1440×940、1280×800、1080×720：三种处理模式无整页滚动，长表单内部滚动，提交按钮可见；高级参数保存通过',
  )
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
