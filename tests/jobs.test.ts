import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Manager } from '../server/manager'
import type { Job } from '../shared/contracts'

test('deleting task records persists removal, preserves outputs, and rejects active batches atomically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'geopress-records-'))
  try {
    const data = path.join(root, 'state')
    await mkdir(data)
    const output = path.join(root, 'result.mbtiles')
    await writeFile(output, 'retained processing output')
    const manager = new Manager(data, root, root)
    const job = (id: string, status: Job['status']): Job => ({
      id,
      status,
      request: {
        kind: 'imagery',
        sourceCrs: '',
        scale: false,
        verticalDatum: 'ellipsoid',
        input: '/input.tif',
        output,
        minZoom: 0,
        maxZoom: 1,
        workers: 1,
      },
      stage: status,
      logs: [],
      createdAt: new Date().toISOString(),
    })
    manager.jobs = [
      job('done', 'succeeded'),
      job('failed', 'failed'),
      job('active', 'running'),
      job('queued', 'queued'),
    ]
    await assert.rejects(manager.removeJobs(['done', 'active']), /不能删除/)
    await assert.rejects(manager.removeJobs(['queued']), /不能删除/)
    assert.equal(manager.jobs.length, 4)
    await manager.removeJobs(['done', 'failed'])
    const saved = JSON.parse(await readFile(path.join(data, 'state.json'), 'utf8'))
    assert.deepEqual(
      saved.jobs.map((entry: Job) => entry.id),
      ['active', 'queued'],
    )
    assert.equal(await readFile(output, 'utf8'), 'retained processing output')
    await manager.removeJobs(['already-removed'])
    assert.equal(manager.jobs.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
