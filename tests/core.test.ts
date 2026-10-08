import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { createServer } from 'node:net'
import { scanDirectory, normalizeMount } from '../server/catalog'
import { NginxServer } from '../server/nginx'
import { findExecutable, Manager, validateJob } from '../server/manager'
import type { Publication, Settings } from '../shared/contracts'
async function port(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port
      s.close(() => resolve(p))
    })
  })
}
const settings: Settings = {
  port: 0,
  host: '127.0.0.1',
  nginx: '',
  python: '',
  gdal: '',
  terrain: '',
  osgb: '',
  cacheSeconds: 0,
  taskConcurrency: 2,
  workerBudget: 4,
}
test('directory validity follows file removal and restoration; symlink resources do not count', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gis-catalog-'))
  try {
    assert.equal((await scanDirectory(root, 'image')).valid, false)
    await writeFile(path.join(root, 'icon.svg'), '<svg/>')
    assert.equal((await scanDirectory(root, 'image')).count, 1)
    await rm(path.join(root, 'icon.svg'))
    assert.equal((await scanDirectory(root, 'image')).valid, false)
    await writeFile(path.join(root, 'icon.svg'), '<svg/>')
    await symlink(path.join(root, 'icon.svg'), path.join(root, 'copy.svg'))
    assert.equal((await scanDirectory(root, 'image')).count, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('3D Tiles references must exist inside the published directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gis-tiles-'))
  try {
    await writeFile(path.join(root, 'model.glb'), 'test')
    const manifest = {
      asset: { version: '1.0' },
      root: { boundingVolume: { sphere: [0, 0, 0, 1] }, content: { uri: 'missing.glb' } },
    }
    await writeFile(path.join(root, 'tileset.json'), JSON.stringify(manifest))
    assert.equal((await scanDirectory(root, 'tileset')).valid, false)
    manifest.root.content.uri = 'model.glb'
    await writeFile(path.join(root, 'tileset.json'), JSON.stringify(manifest))
    assert.equal((await scanDirectory(root, 'tileset')).valid, true)
    manifest.root.content.uri = '../outside.glb'
    await writeFile(path.join(root, 'tileset.json'), JSON.stringify(manifest))
    assert.match((await scanDirectory(root, 'tileset')).reason, /目录之外/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('invalid routes and out-of-range task parameters are rejected', () => {
  for (const route of ['/', '/../a/', '/a;return 200/', '/_gis_status/', '/中文/']) {
    assert.throws(() => normalizeMount(route))
  }
  assert.equal(normalizeMount('terrain/china'), '/terrain/china/')
  assert.throws(() =>
    validateJob({
      kind: 'imagery',
      input: '/in.tif',
      output: '/out',
      minZoom: 12,
      maxZoom: 2,
      workers: 2,
      sourceCrs: '',
      scale: false,
      verticalDatum: 'unknown',
    }),
  )
})
test('real Nginx serves CORS, Range and 100 concurrent requests; invalid mapping returns 503; terrain JSON is not gzip', async (t) => {
  const binary = await findExecutable('', ['nginx', '/opt/homebrew/bin/nginx'])
  if (!binary) {
    t.skip('Nginx not installed')
    return
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gis-nginx-')))
  const directory = path.join(root, '资源 space')
  await mkdir(directory)
  const payload = Buffer.alloc(32 * 1024, 0x61)
  await writeFile(path.join(directory, 'icon.png'), payload)
  const terrain = path.join(root, 'terrain')
  await mkdir(path.join(terrain, '0', '0'), { recursive: true })
  await writeFile(path.join(terrain, '0', '0', '0.terrain'), gzipSync(Buffer.alloc(100)))
  await writeFile(
    path.join(terrain, 'layer.json'),
    JSON.stringify({
      format: 'quantized-mesh-1.0',
      tiles: ['{z}/{x}/{y}.terrain'],
      available: [[{ startX: 0, startY: 0, endX: 0, endY: 0 }]],
    }),
  )
  const p: Publication = {
    id: 'one',
    name: 'one',
    directory,
    mount: '/images/one/',
    kind: 'image',
    enabled: true,
    ...(await scanDirectory(directory, 'image')),
  }
  const terrainPublication: Publication = {
    id: 'two',
    name: 'two',
    directory: terrain,
    mount: '/terrain/test/',
    kind: 'terrain',
    enabled: true,
    ...(await scanDirectory(terrain, 'terrain')),
  }
  const config = { ...settings, port: await port() }
  const nginx = new NginxServer(path.join(root, 'server'))
  const base = `http://127.0.0.1:${config.port}`
  try {
    await nginx.start(binary, config, [p, terrainPublication])
    const response = await fetch(base + p.mount + 'icon.png', { headers: { Range: 'bytes=10-19' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.equal((await response.arrayBuffer()).byteLength, 10)
    const json = await fetch(base + '/terrain/test/layer.json')
    assert.equal(json.status, 200)
    assert.equal(json.headers.get('content-encoding'), null)
    assert.equal((await json.json()).format, 'quantized-mesh-1.0')
    const mesh = await fetch(base + '/terrain/test/0/0/0.terrain')
    assert.equal(mesh.headers.get('content-encoding'), 'gzip')
    assert.equal((await mesh.arrayBuffer()).byteLength, 100)
    const started = performance.now()
    const results = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const r = await fetch(base + p.mount + 'icon.png')
        assert.equal(r.status, 200)
        assert.equal((await r.arrayBuffer()).byteLength, payload.length)
      }),
    )
    assert.equal(results.length, 100)
    t.diagnostic(
      `100 concurrent local resource requests: ${Math.round(performance.now() - started)}ms`,
    )
    p.valid = false
    await nginx.apply(binary, config, [p, terrainPublication])
    await new Promise((r) => setTimeout(r, 150))
    assert.equal((await fetch(base + p.mount + 'icon.png')).status, 503)
    await writeFile(path.join(directory, 'icon.png'), payload)
    p.valid = true
    await nginx.apply(binary, config, [p])
    await new Promise((r) => setTimeout(r, 150))
    assert.equal((await fetch(base + p.mount + 'icon.png')).status, 200)
  } finally {
    await nginx.stop().catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    await rm(root, { recursive: true, force: true })
  }
})
test('manager detects invalid directory, preserves resources on removal, and persists configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gis-manager-'))
  const assets = path.join(root, 'assets')
  await mkdir(assets)
  await writeFile(path.join(assets, 'marker.svg'), '<svg/>')
  const manager = new Manager(path.join(root, 'state'), process.cwd(), process.cwd(), () => {})
  try {
    await manager.initialize()
    await manager.savePublication({
      name: 'marker',
      directory: assets,
      mount: '/icons/',
      kind: 'image',
    })
    const id = manager.publications[0].id
    assert.equal(manager.publications[0].valid, true)
    await rm(path.join(assets, 'marker.svg'))
    await manager.refresh()
    assert.equal(manager.publications[0].valid, false)
    await writeFile(path.join(assets, 'marker.svg'), '<svg/>')
    await manager.refresh()
    assert.equal(manager.publications[0].valid, true)
    await manager.removePublication(id)
    assert.equal((await scanDirectory(assets, 'image')).count, 1)
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelling an executing task terminates its engine and does not publish partial output', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group test')
    return
  }
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { chmod, access } = await import('node:fs/promises')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gis-cancel-')))
  const source = path.join(root, 'source.tif')
  const output = path.join(root, 'out')
  const slow = path.join(root, 'slow-engine')
  const marker = path.join(root, 'engine-started')
  const python = path.join(process.cwd(), '.venv', 'bin', 'python')
  const manager = new Manager(path.join(root, 'state'), process.cwd(), process.cwd(), () => {})
  try {
    await promisify(execFile)(python, [
      '-c',
      "import rasterio,numpy as np,sys;from rasterio.transform import from_origin;d=rasterio.open(sys.argv[1],'w',driver='GTiff',width=32,height=32,count=1,dtype='uint8',crs='EPSG:4326',transform=from_origin(110,31,.01,.01));d.write(np.ones((32,32),dtype='uint8'),1);d.close()",
      source,
    ])
    await writeFile(slow, `#!/bin/sh\nprintf started > '${marker}'\nsleep 60\n`)
    await chmod(slow, 0o755)
    await manager.initialize()
    await manager.saveSettings({ ...manager.settings, python, gdal: slow })
    const id = await manager.submit({
      kind: 'imagery',
      input: source,
      output,
      minZoom: 0,
      maxZoom: 2,
      workers: 1,
      sourceCrs: '',
      scale: false,
      verticalDatum: 'unknown',
    })
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        await access(marker)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    await access(marker)
    await manager.cancel(id)
    const job = manager.jobs.find((j) => j.id === id)!
    assert.equal(job.status, 'cancelled')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await scanDirectory(output, 'imagery')).valid, false)
    assert.equal(manager.publications.length, 0)
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('two jobs run concurrently within worker budget; cancelling one leaves the other running and starts queued work', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gis-parallel-')))
  const manager = new Manager(path.join(root, 'state'), process.cwd(), process.cwd(), () => {})
  const engine = path.join(root, 'slow-engine')
  const source = path.join(root, 'source.tif')
  const { chmod } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const python = path.join(process.cwd(), '.venv', 'bin', 'python')
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (check()) {
        return
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('调度超时')
  }
  try {
    await promisify(execFile)(python, [
      '-c',
      "import rasterio,numpy as np,sys;from rasterio.transform import from_origin;d=rasterio.open(sys.argv[1],'w',driver='GTiff',width=32,height=32,count=1,dtype='uint8',crs='EPSG:4326',transform=from_origin(110,31,.01,.01));d.write(np.ones((32,32),dtype='uint8'),1);d.close()",
      source,
    ])
    await writeFile(engine, '#!/bin/sh\nsleep 60\n')
    await chmod(engine, 0o755)
    await manager.initialize()
    await manager.saveSettings({
      ...manager.settings,
      python,
      gdal: engine,
      taskConcurrency: 2,
      workerBudget: 3,
    })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(
        await manager.submit({
          kind: 'imagery',
          input: source,
          output: path.join(root, 'out' + i),
          minZoom: 0,
          maxZoom: 2,
          workers: 2,
          sourceCrs: '',
          scale: false,
          verticalDatum: 'unknown',
        }),
      )
    }
    await wait(() => manager.jobs.filter((j) => j.status === 'running').length === 2)
    assert.equal(manager.jobs.find((j) => j.id === ids[2])!.status, 'queued')
    assert.equal(
      manager.jobs
        .filter((j) => j.status === 'running')
        .reduce((n, j) => n + j.effectiveWorkers!, 0),
      3,
    )
    await manager.cancel(ids[0])
    await wait(() => manager.jobs.find((j) => j.id === ids[2])!.status === 'running')
    assert.equal(manager.jobs.find((j) => j.id === ids[1])!.status, 'running')
    assert.equal(manager.jobs.find((j) => j.id === ids[0])!.status, 'cancelled')
    await manager.saveSettings({ ...manager.settings, taskConcurrency: 1 })
    assert.equal(manager.jobs.filter((j) => j.status === 'running').length, 2)
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})
