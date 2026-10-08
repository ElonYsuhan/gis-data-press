import { executeWorker } from './infrastructure/worker-client'
import { mkdir, readFile, writeFile, rename, realpath, open } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type {
  Engine,
  Inspection,
  Job,
  JobRequest,
  Publication,
  Settings,
  Snapshot,
} from '../shared/contracts'
import { assertNoOverlap, normalizeMount, scanDirectory } from './catalog'
import { NginxServer } from './nginx'
import { TilePackageServer } from './tile-packages'
import { Downloads } from './downloads'
import type { AssetKind, DownloadRequest } from '../shared/contracts'

export { findExecutable } from './infrastructure/executables'
import { findExecutable } from './infrastructure/executables'
export { validateSettings, validateJob } from './domain/validation'
import { validateSettings, validateJob } from './domain/validation'
export class Manager {
  private downloads: Downloads
  listResources() {
    return this.downloads.list()
  }
  searchBoundaries(q: string) {
    return this.downloads.search(q)
  }
  downloadResource(r: DownloadRequest) {
    return this.downloads.start(r)
  }
  registerResource(kind: AssetKind, p: string) {
    return this.downloads.register(kind, p)
  }
  cancelDownload(id: string) {
    return this.downloads.cancel(id)
  }
  forgetResource(id: string) {
    return this.downloads.forget(id)
  }
  publications: Publication[] = []
  jobs: Job[] = []
  settings: Settings
  nginx: NginxServer
  private packages: TilePackageServer
  engines: Engine[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private runningJobs = new Map<
    string,
    { job: Job; child?: ChildProcess; completion?: Promise<void> }
  >()
  private watchers: FSWatcher[] = []
  private dirtyTimer?: ReturnType<typeof setTimeout>
  private monitor?: ReturnType<typeof setInterval>
  private stopping = false
  private dockerPath = ''
  constructor(
    readonly dataDirectory: string,
    readonly project: string,
    readonly resources: string,
    readonly log: (message: string) => void = console.log,
  ) {
    this.downloads = new Downloads(dataDirectory)
    this.settings = {
      port: 8088,
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
    this.nginx = new NginxServer(path.join(dataDirectory, 'nginx'))
    this.packages = new TilePackageServer(() => this.publications)
  }
  private locked<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action)
    this.queue = next.catch(() => {})
    return next
  }
  async initialize(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true })
    try {
      const state = JSON.parse(await readFile(path.join(this.dataDirectory, 'state.json'), 'utf8'))
      this.settings = validateSettings(state.settings)
      this.publications = state.publications ?? []
      this.jobs = (state.jobs ?? []).map((job: Job) =>
        ['running', 'queued'].includes(job.status)
          ? { ...job, status: 'interrupted', stage: '应用退出时任务中断，请重新提交' }
          : job,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`配置读取失败：${String(error)}`)
      }
    }
    await this.packages.start()
    this.nginx.packagePort = this.packages.port
    await this.downloads.initialize()
    await this.resolveEngines()
    const nginx = this.engines.find((e) => e.id === 'nginx')
    if (nginx?.available) {
      await this.nginx.adopt(nginx.path, this.settings.port)
    }
    await this.refresh()
    if (this.nginx.running) {
      await this.nginx.apply(this.engine('nginx'), this.settings, this.publications)
    }
    this.resetWatchers()
    this.monitor = setInterval(() => {
      void this.refresh().catch((error) => this.log(String(error)))
    }, 30000)
  }
  async resolveEngines(): Promise<void> {
    const bundle = path.join(
      this.resources === this.project ? path.join(this.project, 'resources') : this.resources,
      'engines',
    )
    const ext = process.platform === 'win32' ? '.exe' : ''
    const definitions = [
      ['nginx', 'Nginx 静态服务', [path.join(bundle, 'nginx', 'nginx' + ext), 'nginx' + ext]],
      [
        'python',
        'Python 数据处理',
        [
          path.join(bundle, 'python', 'gis-worker', 'gis-worker' + ext),
          path.join(bundle, 'gis-worker' + ext),
          path.join(this.project, '.venv', 'bin', 'python'),
          'python3',
          'python',
        ],
      ],
      [
        'gdal',
        'GDAL 影像切片',
        [path.join(bundle, 'gdal2tiles' + ext), 'gdal2tiles', 'gdal2tiles.py'],
      ],
      ['terrain', 'CTB Quantized Mesh', [path.join(bundle, 'ctb-tile' + ext), 'ctb-tile' + ext]],
      [
        'osgb',
        'OSGB → 3D Tiles',
        [path.join(bundle, '3dtile' + ext), '3dtile' + ext, '_3dtile' + ext],
      ],
    ] as const
    this.dockerPath = await findExecutable('', ['docker', '/usr/local/bin/docker'])
    this.engines = await Promise.all(
      definitions.map(async ([id, label, candidates]) => {
        let resolved = await findExecutable(this.settings[id], Array.from(candidates))
        if (
          id === 'terrain' &&
          !resolved &&
          (!this.settings.terrain || this.settings.terrain === 'docker://ctb') &&
          this.dockerPath
        ) {
          try {
            await new Promise<void>((resolve, reject) =>
              execFile(
                this.dockerPath,
                ['image', 'inspect', 'ghcr.io/tum-gis/ctb-quantized-mesh:alpine'],
                { timeout: 5000 },
                (error) => (error ? reject(error) : resolve()),
              ),
            )
            resolved = 'docker://ctb'
          } catch {}
        }
        return {
          id,
          label,
          path: resolved,
          available: !!resolved,
          detail: resolved
            ? '可执行文件已找到；转换兼容性将在任务运行时检查'
            : '未找到引擎，请配置本地可执行文件',
        }
      }),
    )
  }
  private engine(id: string): string {
    const engine = this.engines.find((e) => e.id === id)
    if (!engine?.available) {
      throw new Error(`缺少 ${engine?.label ?? id}，请先打开引擎设置`)
    }
    return engine.path
  }
  async persist(): Promise<void> {
    const file = path.join(this.dataDirectory, 'state.json')
    await writeFile(
      file + '.tmp',
      JSON.stringify(
        { settings: this.settings, publications: this.publications, jobs: this.jobs },
        null,
        2,
      ),
    )
    await rename(file + '.tmp', file)
  }
  async refresh(): Promise<void> {
    return this.locked(async () => {
      const previous = JSON.stringify(
        this.publications.map((p) => [p.valid, p.compressed, p.storage]),
      )
      for (const publication of this.publications) {
        Object.assign(publication, await scanDirectory(publication.directory, publication.kind))
      }
      if (this.nginx.running && !(await this.nginx.healthy(this.settings.port))) {
        this.nginx.running = false
        this.nginx.error = 'Nginx 未响应，请检查日志后重新启动'
      }
      if (
        this.nginx.running &&
        (this.nginx.error ||
          previous !==
            JSON.stringify(this.publications.map((p) => [p.valid, p.compressed, p.storage])))
      ) {
        await this.nginx.apply(this.engine('nginx'), this.settings, this.publications)
      }
      await this.persist()
    })
  }
  private resetWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.close()
    }
    this.watchers = []
    for (const p of this.publications) {
      try {
        const watcher = watch(p.directory, { recursive: process.platform !== 'linux' }, () => {
          if (this.dirtyTimer) {
            clearTimeout(this.dirtyTimer)
          }
          this.dirtyTimer = setTimeout(() => {
            void this.refresh().catch((e) => this.log(String(e)))
          }, 1000)
        })
        watcher.on('error', () => {})
        this.watchers.push(watcher)
      } catch {}
    }
  }
  async savePublication(
    value: Pick<Publication, 'name' | 'directory' | 'mount' | 'kind'> & { id?: string },
  ): Promise<void> {
    return this.locked(async () => {
      if (
        !value ||
        typeof value.name !== 'string' ||
        !value.name.trim() ||
        value.name.length > 80
      ) {
        throw new Error('请输入 1–80 字的服务名称')
      }
      if (!['imagery', 'terrain', 'tileset', 'model', 'image'].includes(value.kind)) {
        throw new Error('服务类型无效')
      }
      if (typeof value.directory !== 'string' || !path.isAbsolute(value.directory)) {
        throw new Error('请选择本地绝对目录')
      }
      const directory = await realpath(value.directory)
      const mount = normalizeMount(value.mount)
      assertNoOverlap(this.publications, mount, value.id)
      for (const job of this.jobs.filter((j) => ['queued', 'running'].includes(j.status))) {
        if (
          pathsOverlap(directory, job.request.output) ||
          (job.request.outputFormat === 'package' &&
            pathsOverlap(directory, job.request.output + '.sources'))
        ) {
          throw new Error('目录正在加工，请等待任务完成再发布')
        }
      }
      const old = this.publications
      const existing = old.find((p) => p.id === value.id)
      if (value.id && !existing) {
        throw new Error('服务不存在')
      }
      const publication = {
        id: existing?.id ?? randomUUID(),
        name: value.name.trim(),
        directory,
        mount,
        kind: value.kind,
        enabled: existing?.enabled ?? true,
        ...(await scanDirectory(directory, value.kind)),
      }
      this.publications = existing
        ? old.map((p) => (p.id === existing.id ? publication : p))
        : [...old, publication]
      try {
        if (this.nginx.running) {
          await this.nginx.apply(this.engine('nginx'), this.settings, this.publications)
        }
        await this.persist()
      } catch (error) {
        this.publications = old
        throw error
      }
      this.resetWatchers()
    })
  }
  async togglePublication(id: string): Promise<void> {
    return this.locked(async () => {
      const p = this.publications.find((p) => p.id === id)
      if (!p) {
        throw new Error('服务不存在')
      }
      p.enabled = !p.enabled
      try {
        if (this.nginx.running) {
          await this.nginx.apply(this.engine('nginx'), this.settings, this.publications)
        }
        await this.persist()
      } catch (e) {
        p.enabled = !p.enabled
        throw e
      }
    })
  }
  async removePublication(id: string): Promise<void> {
    return this.locked(async () => {
      const old = this.publications
      this.publications = old.filter((p) => p.id !== id)
      try {
        if (this.nginx.running) {
          await this.nginx.apply(this.engine('nginx'), this.settings, this.publications)
        }
        await this.persist()
      } catch (e) {
        this.publications = old
        throw e
      }
      this.resetWatchers()
    })
  }
  async saveSettings(value: Settings): Promise<void> {
    return this.locked(async () => {
      const next = validateSettings(value)
      if (
        this.nginx.running &&
        (next.port !== this.settings.port ||
          next.host !== this.settings.host ||
          next.nginx !== this.settings.nginx)
      ) {
        throw new Error('修改端口、监听地址或 Nginx 路径前，请先停止服务')
      }
      const old = this.settings
      this.settings = next
      try {
        await this.resolveEngines()
        if (this.nginx.running) {
          await this.nginx.apply(this.engine('nginx'), next, this.publications)
        }
        await this.persist()
        setTimeout(() => void this.pump(), 0)
      } catch (e) {
        this.settings = old
        await this.resolveEngines()
        throw e
      }
    })
  }
  async server(action: 'start' | 'stop'): Promise<void> {
    if (action === 'start') {
      await this.refresh()
    }
    return this.locked(async () => {
      if (action === 'start') {
        await this.nginx.start(this.engine('nginx'), this.settings, this.publications)
      } else if (action === 'stop') {
        await this.nginx.stop()
      } else {
        throw new Error('操作无效')
      }
    })
  }
  async inspect(filename: string): Promise<Inspection> {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
      throw new Error('请选择本地文件')
    }
    return executeWorker<Inspection>(this.engine('python'), this.resources, {
      action: 'inspect',
      path: filename,
    })
  }
  async submit(value: JobRequest): Promise<string> {
    return this.locked(async () => {
      const request = validateJob(value)
      const originalInputs = request.inputs ?? [request.input]
      request.inputs = await Promise.all(
        (request.inputs ?? [request.input]).map((input) => realpath(input)),
      )
      request.heightOffsets = Object.fromEntries(
        originalInputs.map((input, index) => [
          request.inputs![index],
          request.heightOffsets?.[input] ?? 0,
        ]),
      )
      request.input = request.inputs[0]
      request.output = await canonicalPath(request.output)
      if (
        request.inputs.some(
          (input) =>
            pathsOverlap(input, request.output) || pathsOverlap(input, request.output + '.sources'),
        )
      ) {
        throw new Error('输出成果及母数据目录不能与输入重叠')
      }
      this.engine('python')
      if (!(request.kind === 'imagery' && request.outputFormat === 'package')) {
        this.engine(
          request.kind === 'imagery' ? 'gdal' : request.kind === 'terrain' ? 'terrain' : 'osgb',
        )
      }
      const output = path.resolve(request.output)
      const targets = request.outputFormat === 'package' ? [output, output + '.sources'] : [output]
      if (
        this.publications.some((p) => targets.some((target) => pathsOverlap(target, p.directory)))
      ) {
        throw new Error('输出目录与已登记的发布目录重叠，请使用新的空目录')
      }
      if (
        this.jobs.some(
          (j) =>
            ['queued', 'running'].includes(j.status) &&
            targets.some(
              (target) =>
                pathsOverlap(j.request.output, target) ||
                (j.request.outputFormat === 'package' &&
                  pathsOverlap(j.request.output + '.sources', target)),
            ),
        )
      ) {
        throw new Error('该输出目录已有待处理任务')
      }
      const job: Job = {
        id: randomUUID(),
        request,
        status: 'queued',
        stage: '等待执行',
        logs: [],
        createdAt: new Date().toISOString(),
      }
      this.jobs.unshift(job)
      await this.persist()
      setTimeout(() => void this.pump(), 0)
      return job.id
    })
  }
  private async pump(): Promise<void> {
    if (this.stopping) {
      return
    }
    while (this.runningJobs.size < this.settings.taskConcurrency) {
      const used = [...this.runningJobs.values()].reduce(
        (n, r) => n + (r.job.effectiveWorkers ?? 1),
        0,
      )
      const free = this.settings.workerBudget - used
      if (free < 1) {
        return
      }
      const job = this.jobs
        .slice()
        .reverse()
        .find((j) => j.status === 'queued')
      if (!job) {
        return
      }
      job.status = 'running'
      job.stage = '启动加工引擎'
      job.startedAt = new Date().toISOString()
      job.effectiveWorkers = Math.min(job.request.workers, free)
      const running: { job: Job; child?: ChildProcess; completion?: Promise<void> } = { job }
      this.runningJobs.set(job.id, running)
      running.completion = this.runJob(job, running)
    }
  }
  private stopChild(child: ChildProcess) {
    if (!child.pid) {
      return
    }
    const pid = child.pid
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'])
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {}
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {}
      }, 5000)
      child.once('close', () => clearTimeout(timer))
    }
  }
  private async runJob(job: Job, running: { job: Job; child?: ChildProcess }): Promise<void> {
    try {
      await this.locked(() => this.persist())
      if (isCancelled(job)) {
        return
      }
      await executeWorker(
        this.engine('python'),
        this.resources,
        {
          action: 'process',
          request: { ...job.request, workers: job.effectiveWorkers },
          engines: {
            ...Object.fromEntries(this.engines.map((e) => [e.id, e.path])),
            docker: this.dockerPath,
          },
        },
        (event) => {
          if (isCancelled(job)) {
            return
          }
          if (event.event === 'stage') {
            job.stage = event.message
            job.progress = undefined
          }
          if (event.event === 'progress' && Number.isFinite(event.percent)) {
            job.progress = {
              percent: Math.max(0, Math.min(100, event.percent)),
              label: event.label,
            }
          }
          if (event.event === 'log') {
            job.logs.push(event.message)
            if (job.logs.length > 500) {
              job.logs.shift()
            }
          }
        },
        (child) => {
          running.child = child
          if (isCancelled(job)) {
            this.stopChild(child)
          }
        },
      )
      if (!isCancelled(job)) {
        job.status = 'succeeded'
        job.stage =
          job.request.outputFormat === 'package'
            ? '加工完成，可以发布单文件成果'
            : '加工完成，可以发布输出目录'
        job.progress = { percent: 100, label: '已完成' }
      }
    } catch (error) {
      if (!isCancelled(job)) {
        job.status = 'failed'
        job.error = String(error instanceof Error ? error.message : error)
        job.stage = job.error
      }
    } finally {
      job.finishedAt = new Date().toISOString()
      this.runningJobs.delete(job.id)
      await this.locked(() => this.persist())
      if (!this.stopping) {
        void this.pump()
      }
    }
  }
  async cancel(id: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || !['queued', 'running'].includes(job.status)) {
      return
    }
    job.status = 'cancelled'
    job.stage = '已取消'
    job.finishedAt = new Date().toISOString()
    const running = this.runningJobs.get(id)
    if (running?.child) {
      this.stopChild(running.child)
    }
    await this.locked(() => this.persist())
  }
  async snapshot(): Promise<Snapshot> {
    const addresses = [`http://127.0.0.1:${this.settings.port}`]
    if (this.settings.host === '0.0.0.0') {
      for (const list of Object.values(networkInterfaces())) {
        for (const address of list ?? []) {
          if (address.family === 'IPv4' && !address.internal) {
            addresses.push(`http://${address.address}:${this.settings.port}`)
          }
        }
      }
    }
    return {
      publications: this.publications,
      jobs: this.jobs,
      settings: this.settings,
      engines: this.engines,
      server: { running: this.nginx.running, error: this.nginx.error, addresses },
      logs: await tail(path.join(this.nginx.directory, 'logs', 'access.log')),
    }
  }
  async close(options: { keepPublishing?: boolean } = {}): Promise<void> {
    this.stopping = true
    await this.downloads.close()
    await this.packages.close()
    if (this.monitor) {
      clearInterval(this.monitor)
    }
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer)
    }
    for (const w of this.watchers) {
      w.close()
    }
    for (const j of this.jobs.filter((j) => ['queued', 'running'].includes(j.status))) {
      await this.cancel(j.id)
    }
    await Promise.allSettled([...this.runningJobs.values()].map((r) => r.completion))
    await this.locked(async () => {
      if (!options.keepPublishing) {
        await this.nginx.stop()
      }
      await this.persist()
    })
  }
}
export function pathsOverlap(a: string, b: string): boolean {
  const normalize = (v: string) =>
    process.platform === 'win32' ? path.resolve(v).toLowerCase() : path.resolve(v)
  a = normalize(a)
  b = normalize(b)
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
}
async function tail(filename: string): Promise<string[]> {
  try {
    const file = await open(filename, 'r')
    try {
      const info = await file.stat()
      const buffer = Buffer.alloc(Math.min(info.size, 16384))
      await file.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length))
      return buffer.toString().trim().split('\n').slice(-80)
    } finally {
      await file.close()
    }
  } catch {
    return []
  }
}

function isCancelled(job: Job): boolean {
  return job.status === 'cancelled'
}

async function canonicalPath(filename: string): Promise<string> {
  let current = path.resolve(filename)
  const suffix: string[] = []
  while (true) {
    try {
      return path.join(await realpath(current), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      const parent = path.dirname(current)
      if (parent === current) {
        throw error
      }
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}
