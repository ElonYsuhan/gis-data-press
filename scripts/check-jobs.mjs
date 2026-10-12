import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'
const state = await mkdtemp(path.join(os.tmpdir(), 'geopress-jobs-'))
const settings = {
  port: 18999,
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
const jobs = Array.from({ length: 23 }, (_, i) => ({
  id: `task-${i}`,
  status: i % 2 ? 'cancelled' : 'succeeded',
  request: {
    kind: 'imagery',
    input: `/input/source-${i}.tif`,
    output: `/output/result-${i}.mbtiles`,
    minZoom: 0,
    maxZoom: 15,
    workers: 2,
  },
  stage: '加工完成',
  logs: [],
  createdAt: new Date().toISOString(),
}))
await writeFile(
  path.join(state, 'state.json'),
  JSON.stringify({ settings, jobs, publications: [] }),
)
const app = await electron.launch({
  args: [path.resolve('.'), '--user-data-dir=' + path.join(state, 'desktop')],
  env: { ...process.env, GEOPRESS_STATE: state },
})
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '任务中心', exact: true }).click()
  await page.locator('.compact-job').first().waitFor()
  assert.equal(await page.locator('.compact-job').count(), 10)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  assert.match(await page.locator('.compact-job').first().innerText(), /source-10/)
  await page.getByRole('textbox', { name: '检索任务', exact: true }).fill('source-22')
  assert.equal(await page.locator('.compact-job').count(), 1)
  await page.getByRole('textbox', { name: '检索任务', exact: true }).fill('')
  await page.getByRole('combobox', { name: '筛选任务状态', exact: true }).selectOption('cancelled')
  assert.equal(await page.locator('.compact-job.succeeded').count(), 0)
  await page.getByRole('combobox', { name: '筛选任务状态', exact: true }).selectOption('')
  const before = await page.locator('.jobs-toolbar').boundingBox()
  await page.locator('.jobs-list').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  assert.deepEqual(await page.locator('.jobs-toolbar').boundingBox(), before)
  assert.equal(await page.locator('.content').evaluate((el) => el.scrollTop), 0)
  await page.getByRole('checkbox', { name: '本页全选', exact: true }).check()
  await page.getByRole('button', { name: '删除记录（10）', exact: true }).click()
  await page.waitForFunction(() =>
    document.querySelector('.jobs-pagination')?.textContent.includes('共 13 条'),
  )
  await page.getByRole('button', { name: '删除任务记录 source-10.tif', exact: true }).click()
  await page.waitForFunction(() =>
    document.querySelector('.jobs-pagination')?.textContent.includes('共 12 条'),
  )
  assert.equal(JSON.parse(await readFile(path.join(state, 'state.json'), 'utf8')).jobs.length, 12)
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/jobs.png' })
  console.log('Jobs search, pagination, fixed toolbar, single and bulk persistent deletion passed')
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
