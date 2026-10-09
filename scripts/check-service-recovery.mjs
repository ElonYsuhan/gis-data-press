import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const project = path.resolve(import.meta.dirname, '..')
const { connectService } = await import(project + '/electron/service-client.ts')
for (const busy of [false, true]) {
  const state = await mkdtemp(path.join(os.tmpdir(), 'geopress-recover-'))
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import http from 'node:http';const s=http.createServer(async(req,res)=>{for await(const c of req){};if(req.url==='/snapshot')return;const result=req.url==='/ping'?{pid:process.pid,protocol:5}:{activeJobs:${busy},activeDownloads:false,mutations:0};res.end(JSON.stringify({result}))});s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:s.address().port,token:'test-only'})));`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  let endpoint
  try {
    endpoint = await new Promise((resolve) =>
      child.stdout.once('data', (b) => resolve(JSON.parse(b.toString()))),
    )
    await writeFile(path.join(state, 'service.json'), JSON.stringify(endpoint))
    const manager = await connectService(state, project, project)
    if (busy) {
      await assert.rejects(manager.snapshot(), /有任务或操作进行中/)
      process.kill(child.pid, 0)
    } else {
      const snapshot = await manager.snapshot()
      assert.ok(Array.isArray(snapshot.jobs))
      const next = JSON.parse(await readFile(path.join(state, 'service.json'), 'utf8'))
      assert.notEqual(next.pid, child.pid)
      process.kill(next.pid, 'SIGTERM')
    }
    console.log(busy ? 'Active work protected' : 'Unresponsive idle service recovered')
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {}
    await rm(state, { recursive: true, force: true })
  }
}
