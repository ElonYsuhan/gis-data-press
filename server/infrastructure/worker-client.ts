import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
export type WorkerEvent =
  | { event: 'result'; value: unknown }
  | { event: 'error' | 'stage' | 'log'; message: string }
  | { event: 'progress'; percent: number; label?: string }

/** Reject malformed engine messages before applying them to a job. */
function parseWorkerEvent(value: unknown): WorkerEvent {
  if (!value || typeof value !== 'object' || !('event' in value)) {
    throw new Error('Invalid worker event')
  }
  const event = value as Record<string, unknown>
  if (event.event === 'result') {
    return { event: 'result', value: event.value }
  }
  if (
    ['error', 'stage', 'log'].includes(String(event.event)) &&
    typeof event.message === 'string'
  ) {
    return { event: event.event as 'error' | 'stage' | 'log', message: event.message }
  }
  if (
    event.event === 'progress' &&
    typeof event.percent === 'number' &&
    Number.isFinite(event.percent)
  ) {
    return {
      event: 'progress',
      percent: event.percent,
      label: typeof event.label === 'string' ? event.label : undefined,
    }
  }
  throw new Error('Invalid worker event')
}
export function executeWorker<T>(
  python: string,
  resources: string,
  payload: unknown,
  onEvent?: (event: WorkerEvent) => void,
  onChild?: (child: ChildProcess) => void,
): Promise<T> {
  const bundled = path.basename(python).startsWith('gis-worker')
  const script = path.join(resources, 'python', 'worker.py')
  return new Promise((resolve, reject) => {
    const child = spawn(python, bundled ? [] : [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    onChild?.(child)
    let buffer = ''
    let result: T | undefined
    let failure = ''
    let stderr = ''
    let timeout: ReturnType<typeof setTimeout> | undefined
    if (!onEvent) {
      timeout = setTimeout(() => {
        child.kill()
        reject(new Error('读取数据超时，请检查文件和依赖'))
      }, 60000)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.length > 1024 * 1024) {
        child.kill()
        reject(new Error('处理引擎输出异常'))
        return
      }
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        try {
          const event = parseWorkerEvent(JSON.parse(line))
          if (event.event === 'result') {
            result = event.value as T
          }
          if (event.event === 'error') {
            failure = event.message
          }
          onEvent?.(event)
        } catch {}
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000)
    })
    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      reject(error)
    })
    child.on('close', (code) => {
      if (timeout) {
        clearTimeout(timeout)
      }
      if (code !== 0 || result === undefined) {
        reject(new Error(failure || stderr || '处理引擎中断'))
      } else {
        resolve(result)
      }
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(payload))
  })
}
