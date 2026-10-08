/** End-to-end multi-input processing and Cesium reading, using a disposable profile. */
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, rm, stat, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { cleanupTestService } from './cleanup-test-service.mjs'

const state = await mkdtemp(path.join(os.tmpdir(), 'geopress-processing-package-'))
const cesiumChunk = (await readdir(path.resolve('dist/assets'))).find((filename) =>
  /^Cesium-.*\.js$/.test(filename),
)
const inputs = [path.join(state, 'coarse.tif'), path.join(state, 'fine.tif')]
execFileSync(path.resolve('.venv/bin/python'), [
  '-c',
  `
import rasterio,numpy as np,sys
from rasterio.transform import from_origin
for index,path in enumerate(sys.argv[1:]):
    with rasterio.open(path,'w',driver='GTiff',width=32,height=32,count=4,dtype='uint8',crs='EPSG:3857',transform=from_origin(12000000+index*1000,4200000,1000/(index+1),1000/(index+1))) as ds:
        pixels=np.full((4,32,32),80+index*100,dtype='uint8');pixels[3]=255;ds.write(pixels)
        ds.colorinterp=(rasterio.enums.ColorInterp.red,rasterio.enums.ColorInterp.green,rasterio.enums.ColorInterp.blue,rasterio.enums.ColorInterp.alpha)
`,
  ...inputs,
])
const socket = createServer()
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
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
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '数据处理', exact: true }).click()
  await page.getByLabel('输入 TIFF / VRT 文件', { exact: true }).fill(inputs[0])
  await page.getByText('手动添加路径', { exact: true }).click()
  await page
    .getByLabel('其他输入文件（可多选，或每行填写一个路径）', { exact: true })
    .fill(inputs[1])
  await page.getByLabel('成果文件路径', { exact: true }).fill(path.join(state, 'fused.mbtiles'))
  await page.getByLabel('最大层级', { exact: true }).fill('8')
  await page.getByLabel('最大层级', { exact: true }).press('Tab')
  await page.getByRole('button', { name: '提交加工任务', exact: true }).click()
  await page
    .getByRole('heading', { name: '任务中心', exact: true })
    .waitFor({ timeout: 5000 })
    .catch(async (error) => {
      console.log(await page.locator('body').innerText())
      console.log(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll(':invalid')).map((element) => ({
            tag: element.tagName,
            id: element.id,
            value: element.value,
            message: element.validationMessage,
          })),
        ),
      )
      throw error
    })
  await page.getByText('已完成', { exact: true }).waitFor({ timeout: 90000 })
  const snapshot = await page.evaluate(() => window.gis.snapshot())
  const job = snapshot.jobs[0]
  assert.equal(job.request.inputs.length, 2)
  assert.equal(job.request.outputFormat, 'package')
  assert.ok((await stat(job.request.output)).isFile())
  assert.ok((await stat(job.request.output + '.sources/master.tif')).isFile())
  await page.getByRole('button', { name: '发布', exact: true }).click()
  await page.getByRole('button', { name: '保存目录映射', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  const terrainFile = path.resolve(
    '.test-artifacts/package-integration/fused-quality.terrain.sqlite',
  )
  const info = await page.evaluate(
    async ({ port, terrainFile }) => {
      const snapshot = await window.gis.snapshot()
      await window.gis.saveSettings({ ...snapshot.settings, port })
      await window.gis.savePublication({
        name: '融合地形验证',
        directory: terrainFile,
        kind: 'terrain',
        mount: '/terrain/check/',
      })
      await window.gis.server('start')
      return window.gis.snapshot()
    },
    { port, terrainFile },
  )
  assert.ok(info.publications.every((p) => p.valid && p.storage === 'package'))
  const imagery = info.publications.find((p) => p.kind === 'imagery')
  const response = await fetch(`http://127.0.0.1:${port}${imagery.mount}${imagery.indexed[0].path}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  await page.getByRole('button', { name: /服务发布/ }).click()
  await page.getByRole('button', { name: '预览 融合地形验证', exact: true }).click()
  await page.locator('.cesium-widget canvas').waitFor()
  const layer = await fetch(`http://127.0.0.1:${port}/terrain/check/layer.json`)
  assert.equal((await layer.json()).format, 'quantized-mesh-1.0')
  // Execute the same Cesium provider API from the packaged module inside the browser.
  const providerCheck = await page.evaluate(
    async ({ port, cesiumChunk }) => {
      const Cesium = await import('/assets/' + cesiumChunk)
      const provider = await Cesium.CesiumTerrainProvider.fromUrl(
        `http://127.0.0.1:${port}/terrain/check/`,
      )
      const position = Cesium.Cartographic.fromDegrees(110.025, 29.99)
      const coordinates = provider.tilingScheme.positionToTileXY(position, 12)
      const tile = await provider.requestTileGeometry(coordinates.x, coordinates.y, 12)
      return {
        loaded: true,
        sampled: true,
        height: tile.interpolateHeight(
          provider.tilingScheme.tileXYToRectangle(coordinates.x, coordinates.y, 12),
          position.longitude,
          position.latitude,
        ),
      }
    },
    { port, cesiumChunk },
  )
  assert.ok(providerCheck.loaded && providerCheck.sampled)
  assert.ok(Math.abs(providerCheck.height - 200) < 2, JSON.stringify(providerCheck))
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/package-terrain-preview.png' })
  await page.getByRole('button', { name: /关闭.*预览/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      inputs: 2,
      imageryPackage: true,
      retainedMaster: true,
      terrainPackage: true,
      nginx: true,
      cesium: providerCheck,
    }),
  )
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
