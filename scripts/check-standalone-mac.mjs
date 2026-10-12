/** Exercise the shipped app with no Python, GDAL, Homebrew or Docker on PATH. */
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, cp, rm, readFile, stat, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'geopress-standalone-')))
const state = path.join(root, 'state')
const input = path.join(root, 'input.tif')
const dem = path.join(root, 'dem.tif')
// Fixture preparation is a development step; processing below uses only the shipped application.
execFileSync(path.resolve('.venv/bin/python'), [
  '-c',
  `
import sys,numpy as np,rasterio
from rasterio.transform import from_origin
for i,p in enumerate(sys.argv[1:]):
 with rasterio.open(p,'w',driver='GTiff',width=32,height=32,count=4 if i==0 else 1,dtype='uint8' if i==0 else 'float32',crs='EPSG:3857',transform=from_origin(12000000,4200000,1000,1000)) as ds:
  ds.write(np.full((ds.count,32,32),100,dtype=ds.dtypes[0]))
  if i==0:
   ds.colorinterp=(rasterio.enums.ColorInterp.red,rasterio.enums.ColorInterp.green,rasterio.enums.ColorInterp.blue,rasterio.enums.ColorInterp.alpha)
`,
  input,
  dem,
])
const model = path.join(root, 'model')
await mkdir(path.join(model, 'Data', 'Tile_0'), { recursive: true })
await cp('tests/fixtures/model.osgb', path.join(model, 'Data', 'Tile_0', 'Tile_0.osgb'))
// Copy the whole app into a new path with spaces, testing relocatability as well as dependencies.
const executable =
  process.env.GEOPRESS_TEST_EXECUTABLE ??
  path.resolve('release/mac-arm64/GeoPress.app/Contents/MacOS/GeoPress')
const appPath = path.resolve(executable, '../../..')
const relocated = path.join(root, 'Copy with spaces', 'GeoPress.app')
await cp(appPath, relocated, { recursive: true, verbatimSymlinks: true })
console.log('Copied app to', relocated)
const cleanEnv = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GEOPRESS_STATE: state }
for (const key of [
  'PYTHONPATH',
  'PYTHONHOME',
  'GDAL_DATA',
  'PROJ_DATA',
  'PROJ_LIB',
  'OSG_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
]) {
  delete cleanEnv[key]
}
const app = await electron.launch({
  executablePath: path.join(relocated, 'Contents/MacOS/GeoPress'),
  args: ['--user-data-dir=' + path.join(root, 'desktop')],
  env: cleanEnv,
})
try {
  console.log('Application launched')
  const page = await app.firstWindow()
  console.log('Window ready')
  const initial = await page.evaluate(() => window.gis.snapshot())
  assert.ok(
    initial.engines.every((engine) => engine.available && engine.path.startsWith(relocated)),
    JSON.stringify(initial.engines),
  )
  assert.equal((await page.evaluate((p) => window.gis.inspect(p), dem)).bands, 1)
  const requests = [
    { kind: 'imagery', input, outputFormat: 'package', output: path.join(root, 'image.mbtiles') },
    { kind: 'imagery', input, outputFormat: 'directory', output: path.join(root, 'xyz') },
    {
      kind: 'terrain',
      input: dem,
      outputFormat: 'package',
      output: path.join(root, 'dem.terrain.sqlite'),
    },
    { kind: 'terrain', input: dem, outputFormat: 'directory', output: path.join(root, 'terrain') },
    {
      kind: 'osgb',
      input: model,
      outputFormat: 'directory',
      output: path.join(root, 'tileset'),
      longitude: 108.9,
      latitude: 34.2,
    },
  ]
  for (const value of requests) {
    const request = {
      minZoom: 0,
      maxZoom: 3,
      workers: 2,
      sourceCrs: '',
      scale: false,
      verticalDatum: 'ellipsoid',
      fusionPolicy: 'precision',
      ...value,
    }
    const id = await page.evaluate((r) => window.gis.submit(r), request)
    let job
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      job = (await page.evaluate(() => window.gis.snapshot())).jobs.find((j) => j.id === id)
      if (!['queued', 'running'].includes(job.status)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.equal(job.status, 'succeeded', JSON.stringify(job))
    assert.ok(await stat(request.output))
    console.log('PASS', value.kind, value.outputFormat)
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'tileset/tileset.json'), 'utf8'))
  assert.ok(manifest.root.children?.length > 0, JSON.stringify(manifest))
  const mesh = await readFile(path.join(root, 'tileset/Data/Tile_0/Tile_0.b3dm'))
  assert.equal(mesh.subarray(0, 4).toString(), 'b3dm')
  // A unique temporary HTTP port, independent of the user's publishing service.
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  await page.evaluate(
    async ({ directory, port }) => {
      const snapshot = await window.gis.snapshot()
      await window.gis.saveSettings({ ...snapshot.settings, port })
      await window.gis.savePublication({
        name: 'Standalone imagery',
        kind: 'imagery',
        directory,
        mount: '/standalone/',
      })
      await window.gis.server('start')
    },
    { directory: path.join(root, 'image.mbtiles'), port },
  )
  const published = (await page.evaluate(() => window.gis.snapshot())).publications[0]
  const response = await fetch(
    `http://127.0.0.1:${port}${published.mount}${published.indexed[0].path}`,
  )
  assert.equal(response.status, 200)
  assert.ok((await response.arrayBuffer()).byteLength > 0)
  await page.evaluate(() => window.gis.server('stop'))
  console.log('PASS Nginx publication and tile download')
  console.log('All shipped converters passed from relocated app with clean PATH')
} catch (error) {
  console.error(error)
  throw error
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(root, { recursive: true, force: true })
}
