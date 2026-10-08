import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
export async function findExecutable(value: string, candidates: string[] = []): Promise<string> {
  for (const candidate of value ? [value] : candidates) {
    const options =
      candidate.includes('/') || candidate.includes('\\')
        ? [candidate]
        : (process.env.PATH ?? '').split(path.delimiter).map((p) => path.join(p, candidate))
    for (const option of options) {
      try {
        await access(option, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        if ((await stat(option)).isFile()) {
          return option
        }
      } catch {}
    }
  }
  return ''
}
