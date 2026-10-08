/** Packaged UI regression check. All files and services use an isolated temporary profile. */
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'

const state = await mkdtemp(path.join(os.tmpdir(), 'geopress-ui-'))
const executablePath =
  process.env.GEOPRESS_TEST_EXECUTABLE ??
  path.resolve('release/mac-arm64/GeoPress.app/Contents/MacOS/GeoPress')
const fixture = path.join(state, 'source.tif')
execFileSync(path.resolve('.venv/bin/python'), [
  '-c',
  `
import numpy as np
import rasterio
from rasterio.transform import from_origin
with rasterio.open(${JSON.stringify(fixture)}, 'w', driver='GTiff', width=32, height=32, count=4, dtype='uint8', crs='EPSG:3857', transform=from_origin(0, 0, 5, 5)) as ds:
    ds.write(np.full((4,32,32), 255, dtype='uint8'))
    ds.colorinterp=(rasterio.enums.ColorInterp.red,rasterio.enums.ColorInterp.green,rasterio.enums.ColorInterp.blue,rasterio.enums.ColorInterp.alpha)
`,
])
const app = await electron.launch({
  executablePath,
  args: ['--user-data-dir=' + path.join(state, 'desktop')],
  env: { ...process.env, GEOPRESS_STATE: state },
})
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '数据处理', exact: true }).click()
  assert.ok((await page.locator('.n-input').count()) > 0)
  await page.getByRole('radio', { name: '按分辨率自动换算', exact: true }).check()
  await page.getByLabel('源数据水平分辨率', { exact: true }).fill('5')
  await page.getByLabel('源数据水平分辨率', { exact: true }).press('Tab')
  assert.equal(await page.getByLabel('最大层级', { exact: true }).inputValue(), '15')
  await page.getByRole('radio', { name: /地形切片/ }).check()
  await page.getByLabel('源数据水平分辨率', { exact: true }).fill('30')
  await page.getByLabel('源数据水平分辨率', { exact: true }).press('Tab')
  assert.equal(await page.getByLabel('最大层级', { exact: true }).inputValue(), '14')
  assert.equal(await page.getByLabel('最小层级', { exact: true }).inputValue(), '0')
  await page.getByRole('radio', { name: /影像切片/ }).check()
  await page.getByRole('radio', { name: '手动填写层级', exact: true }).check()
  await page.getByLabel('最大层级', { exact: true }).fill('16')
  await page.getByLabel('最大层级', { exact: true }).press('Tab')
  assert.equal(await page.getByLabel('最大层级', { exact: true }).inputValue(), '16')
  await page.getByRole('button', { name: '高级参数', exact: true }).click()
  await page.getByRole('dialog', { name: '高级参数', exact: true }).waitFor()
  await page.getByLabel('源坐标系（可选）', { exact: true }).fill('EPSG:3857')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.getByRole('dialog', { name: '高级参数', exact: true }).waitFor({ state: 'hidden' })
  await page.getByLabel('输入 TIFF / VRT 文件', { exact: true }).fill(fixture)
  await page.getByRole('button', { name: '读取数据元信息', exact: true }).click()
  await page.getByText('EPSG:3857', { exact: true }).waitFor()
  await page.getByLabel('成果文件路径', { exact: true }).fill(path.join(state, 'tiles.mbtiles'))
  await page.getByLabel('最大层级', { exact: true }).fill('0')
  await page.getByLabel('最大层级', { exact: true }).press('Tab')
  await page.getByRole('button', { name: '提交加工任务', exact: true }).click()
  await page.getByRole('heading', { name: '任务中心', exact: true }).waitFor()
  await page.getByText('已完成', { exact: true }).waitFor({ timeout: 90000 })
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await page.getByRole('dialog', { name: '登记资源目录', exact: true }).waitFor()
  await page.getByRole('button', { name: '保存目录映射', exact: true }).click()
  await page.getByRole('dialog', { name: '登记资源目录', exact: true }).waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: /服务发布/ }).click()
  await page.getByRole('table').waitFor()
  await page.getByRole('button', { name: '资源下载', exact: true }).click()
  await page.getByRole('button', { name: '检索', exact: true }).waitFor()
  await page.getByRole('button', { name: '引擎与设置', exact: true }).click()
  await page.getByLabel('监听端口', { exact: true }).waitFor()
  await page.getByRole('button', { name: '数据处理', exact: true }).click()
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/naive-processing.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log(
    'Naive UI: resolution conversion, manual zoom, modal, bundled worker inspection, imagery task, publication and all pages passed',
  )
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
