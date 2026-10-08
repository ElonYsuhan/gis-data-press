import { readFile } from 'node:fs/promises'
import path from 'node:path'
// Only used with temporary acceptance-test profiles, never the user's publishing profile.
export async function cleanupTestService(state) {
  let endpoint
  try {
    endpoint = JSON.parse(await readFile(path.join(state, 'service.json'), 'utf8'))
  } catch {
    return
  }
  await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.token}` },
    body: '[]',
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(endpoint.pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('测试后台未及时退出')
}
