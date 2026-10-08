import { kindLabels } from '../../shared/contracts'
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  type Snapshot,
  type Publication,
  type ServiceKind,
  type Settings,
  type Inspection,
  type JobRequest,
  type Job,
} from '../../shared/contracts'
import { api as managementAPI } from '../services/api'
import { inject, provide, type InjectionKey } from 'vue'
import { Image, Mountain, Layers3, Box } from 'lucide-vue-next'
import type { DialogHandle } from '../components/dialog'

export function useWorkspace() {
  const api = managementAPI
  const tab = ref<'services' | 'process' | 'jobs' | 'settings' | 'resources'>('services')
  const snapshot = ref<Snapshot>()
  const search = ref('')
  const selected = ref('')
  const busy = ref(false)
  const error = ref('')
  const notice = ref('')
  const inspection = ref<Inspection>()
  const inspecting = ref(false)
  const removalDialog = ref<DialogHandle>()
  const pendingRemoval = ref<Publication>()
  const removalError = ref('')
  const advancedDialog = ref<DialogHandle>()
  const serviceDialog = ref<DialogHandle>()
  const previewDialog = ref<DialogHandle>()
  const previewPublication = ref<Publication>()
  const dialogTitle = ref('登记资源目录')
  const form = ref({
    id: undefined as string | undefined,
    name: '',
    directory: '',
    mount: '',
    kind: 'imagery' as ServiceKind,
  })
  const settings = ref<Settings>()
  const settingsDirty = ref(false)
  const request = ref<JobRequest>({
    kind: 'imagery',
    input: '',
    inputs: [],
    outputFormat: 'package',
    fusionPolicy: 'precision',
    heightOffsets: {},
    output: '',
    minZoom: 0,
    maxZoom: 15,
    workers: 2,
    sourceCrs: '',
    scale: false,
    verticalDatum: 'unknown',
  })
  const kinds = ['imagery', 'terrain', 'tileset', 'model', 'image'] as ServiceKind[]
  const kindOptions = kinds.map((kind) => ({ label: kindLabels[kind], value: kind }))
  const publications = computed(() => snapshot.value?.publications ?? [])
  const filtered = computed(() =>
    publications.value.filter((p) =>
      `${p.name} ${p.directory} ${p.mount}`.toLowerCase().includes(search.value.toLowerCase()),
    ),
  )
  const current = computed(() => publications.value.find((p) => p.id === selected.value))
  const available = computed(() => publications.value.filter((p) => p.valid && p.enabled).length)
  const activeJobs = computed(
    () => snapshot.value?.jobs.filter((j) => ['running', 'queued'].includes(j.status)).length ?? 0,
  )
  const taskEngine = computed(() =>
    snapshot.value?.engines.find(
      (e) =>
        e.id ===
        (request.value.kind === 'imagery'
          ? 'gdal'
          : request.value.kind === 'terrain'
            ? 'terrain'
            : 'osgb'),
    ),
  )
  const packageImagery = computed(
    () => request.value.kind === 'imagery' && request.value.outputFormat === 'package',
  )
  const taskReady = computed(
    () =>
      (packageImagery.value || taskEngine.value?.available) &&
      snapshot.value?.engines.find((e) => e.id === 'python')?.available,
  )
  const base = computed(
    () =>
      snapshot.value?.server.addresses[1] ??
      snapshot.value?.server.addresses[0] ??
      'http://127.0.0.1:8088',
  )
  const serviceURL = (p: Publication) =>
    base.value +
    p.mount +
    (p.kind === 'terrain'
      ? 'layer.json'
      : p.kind === 'tileset'
        ? 'tileset.json'
        : p.kind === 'imagery'
          ? `{z}/{x}/{y}.${p.indexed[0]?.path.split('.').pop() ?? 'png'}`
          : (p.indexed[0]?.path ?? ''))
  const status = (p: Publication) =>
    !p.enabled
      ? '已停用'
      : !p.valid
        ? '目录无效'
        : !snapshot.value?.server.running
          ? '待启动'
          : '已发布'
  const jobLabels: Record<string, string> = {
    queued: '等待执行',
    running: '处理中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  }
  const jobNames: Record<string, string> = {
    imagery: '影像切片',
    terrain: '地形切片',
    osgb: 'OSGB 转 3D Tiles',
  }
  const icons = { imagery: Image, terrain: Mountain, tileset: Layers3, model: Box, image: Image }
  const bytes = (n: number) =>
    n >= 1e9
      ? (n / 1e9).toFixed(2) + ' GB'
      : n >= 1e6
        ? (n / 1e6).toFixed(1) + ' MB'
        : n >= 1e3
          ? (n / 1e3).toFixed(1) + ' KB'
          : n + ' B'
  const time = (date: string) => new Date(date).toLocaleString('zh-CN', { hour12: false })
  let interval: ReturnType<typeof setInterval>
  let polling = false
  let restoreFocus: HTMLElement | null = null
  async function poll() {
    if (polling) {
      return
    }
    polling = true
    try {
      snapshot.value = await api.snapshot()
      if (!settingsDirty.value) {
        settings.value = { ...snapshot.value.settings }
      }
    } catch (e) {
      error.value = String(e)
    } finally {
      polling = false
    }
  }
  async function action(fn: () => Promise<unknown>, message = '') {
    if (busy.value) {
      return
    }
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      await fn()
      await poll()
      notice.value = message
    } catch (e) {
      error.value = String(e).replace(/^Error: /, '')
    } finally {
      busy.value = false
    }
  }
  async function choose(target: 'directory' | 'input' | 'output') {
    const mode = target === 'input' && request.value.kind !== 'osgb' ? 'file' : 'directory'
    if (target === 'input' && request.value.kind !== 'osgb') {
      const files = await api.chooseFiles()
      if (files.length) {
        request.value.input = files[0]
        request.value.inputs = files
        await inspect()
      }
      return
    }
    const filename =
      target === 'output' &&
      request.value.kind !== 'osgb' &&
      request.value.outputFormat === 'package'
        ? await api.chooseOutput(request.value.kind)
        : await api.choose(mode)
    if (!filename) {
      return
    }
    if (target === 'directory') {
      form.value.directory = filename
      if (!form.value.name) {
        form.value.name = filename.split(/[\\/]/).pop() ?? ''
      }
    } else {
      request.value[target] = filename
      if (target === 'input') {
        await inspect()
      }
    }
  }
  async function inspect() {
    if (!request.value.input) {
      return
    }
    inspection.value = undefined
    inspecting.value = true
    try {
      inspection.value = await api.inspect(request.value.input)
    } catch (e) {
      error.value = String(e)
    } finally {
      inspecting.value = false
    }
  }
  async function openService(p?: Publication) {
    form.value = p
      ? { id: p.id, name: p.name, directory: p.directory, mount: p.mount, kind: p.kind }
      : { id: undefined, name: '', directory: '', mount: '', kind: 'imagery' }
    dialogTitle.value = p ? '编辑目录映射' : '登记资源目录'
    restoreFocus = document.activeElement as HTMLElement
    serviceDialog.value?.showModal()
    await nextTick()
    serviceDialog.value?.querySelector<HTMLInputElement>('input')?.focus()
  }
  function closeDialog(dialog?: DialogHandle) {
    dialog?.close()
    restoreFocus?.focus()
  }
  async function saveService() {
    await action(async () => {
      await api.savePublication({ ...form.value })
      closeDialog(serviceDialog.value)
    }, '目录映射已保存')
  }
  async function openRemoval(p: Publication) {
    pendingRemoval.value = p
    removalError.value = ''
    restoreFocus = document.activeElement as HTMLElement
    removalDialog.value?.showModal()
    await nextTick()
    removalDialog.value?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus()
  }
  function finishRemoval() {
    pendingRemoval.value = undefined
    if (restoreFocus?.isConnected) {
      restoreFocus.focus()
    } else {
      document.querySelector<HTMLButtonElement>('.page-heading .primary')?.focus()
    }
  }
  async function confirmRemoval() {
    if (busy.value || !pendingRemoval.value) {
      return
    }
    busy.value = true
    removalError.value = ''
    const id = pendingRemoval.value.id
    try {
      await api.removePublication(id)
      if (selected.value === id) {
        selected.value = ''
      }
      closeDialog(removalDialog.value)
      await poll()
      notice.value = '已移除映射配置，磁盘文件保留'
    } catch (e) {
      removalError.value = String(e).replace(/^Error: /, '')
    } finally {
      busy.value = false
    }
  }
  async function openPreview(p: Publication) {
    if (!p.valid || !p.enabled || !snapshot.value?.server.running) {
      error.value = '请先保证目录有效，并启动发布服务'
      return
    }
    restoreFocus = document.activeElement as HTMLElement
    previewPublication.value = p
    previewDialog.value?.showModal()
  }
  async function publishJob(job: Job) {
    await openService()
    form.value = {
      id: undefined,
      name: job.request.output.split(/[\\/]/).pop() ?? '加工成果',
      directory: job.request.output,
      mount: `/${job.request.kind === 'osgb' ? 'tilesets' : job.request.kind}/${job.id.slice(0, 8)}/`,
      kind: job.request.kind === 'osgb' ? 'tileset' : job.request.kind,
    }
  }
  async function saveSettings() {
    if (!settings.value) {
      return
    }
    await action(async () => {
      await api.saveSettings({ ...settings.value! })
      settingsDirty.value = false
    }, '设置已保存')
  }
  async function selectEngine(key: 'nginx' | 'python' | 'gdal' | 'terrain' | 'osgb') {
    const file = await api.choose('executable')
    if (file && settings.value) {
      settings.value[key] = file
      settingsDirty.value = true
    }
  }
  async function submit() {
    await action(async () => {
      await api.submit({
        ...request.value,
        heightOffsets: { ...request.value.heightOffsets },
        inputs:
          request.value.kind === 'osgb'
            ? [request.value.input]
            : [
                request.value.input,
                ...(request.value.inputs ?? []).filter((path) => path !== request.value.input),
              ].filter(Boolean),
        longitude:
          typeof request.value.longitude === 'number' ? request.value.longitude : undefined,
        latitude: typeof request.value.latitude === 'number' ? request.value.latitude : undefined,
      })
      tab.value = 'jobs'
    }, '加工任务已提交')
  }
  function sample(p: Publication) {
    const url = base.value + p.mount
    if (p.kind === 'terrain') {
      return `const terrain = await Cesium.CesiumTerrainProvider.fromUrl(${JSON.stringify(url)});\nviewer.terrainProvider = terrain;`
    }
    if (p.kind === 'tileset') {
      return `const tileset = await Cesium.Cesium3DTileset.fromUrl(${JSON.stringify(url + 'tileset.json')});\nviewer.scene.primitives.add(tileset);\nawait viewer.zoomTo(tileset);`
    }
    if (p.kind === 'imagery') {
      return `viewer.imageryLayers.addImageryProvider(\n  new Cesium.UrlTemplateImageryProvider({\n    url: ${JSON.stringify(serviceURL(p))},\n    minimumLevel: ${p.minZoom ?? 0},\n    maximumLevel: ${p.maxZoom ?? 18}\n  })\n);`
    }
    if (p.kind === 'model') {
      return `viewer.entities.add({\n  position: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),\n  model: { uri: ${JSON.stringify(serviceURL(p))} }\n});`
    }
    return serviceURL(p)
  }
  onMounted(async () => {
    await poll()
    interval = setInterval(() => void poll(), 2500)
  })
  onBeforeUnmount(() => clearInterval(interval))
  function selectProcessingKind(kind: JobRequest['kind']) {
    request.value.kind = kind
    inspection.value = undefined
    request.value.input = ''
    request.value.inputs = []
    request.value.output = ''
    request.value.outputFormat = kind === 'osgb' ? 'directory' : 'package'
    request.value.maxZoom = kind === 'terrain' ? 14 : 15
  }
  function openAdvancedParameters(event: Event) {
    rememberFocus(event)
    advancedDialog.value?.showModal()
  }
  function rememberFocus(event: Event) {
    restoreFocus = event.currentTarget as HTMLElement
  }

  return {
    api,
    tab,
    snapshot,
    search,
    selected,
    busy,
    error,
    notice,
    inspection,
    inspecting,
    removalDialog,
    pendingRemoval,
    removalError,
    advancedDialog,
    serviceDialog,
    previewDialog,
    previewPublication,
    dialogTitle,
    form,
    settings,
    settingsDirty,
    request,
    kinds,
    kindOptions,
    publications,
    filtered,
    current,
    available,
    activeJobs,
    taskEngine,
    taskReady,
    packageImagery,
    base,
    serviceURL,
    status,
    jobLabels,
    jobNames,
    icons,
    bytes,
    time,
    poll,
    action,
    choose,
    inspect,
    openService,
    closeDialog,
    saveService,
    openRemoval,
    finishRemoval,
    confirmRemoval,
    openPreview,
    publishJob,
    saveSettings,
    selectEngine,
    submit,
    sample,
    rememberFocus,
    openAdvancedParameters,
    selectProcessingKind,
  }
}
export type Workspace = ReturnType<typeof useWorkspace>
const workspaceKey: InjectionKey<Workspace> = Symbol('workspace')
export function provideWorkspace(workspace: Workspace) {
  provide(workspaceKey, workspace)
}
export function useWorkspaceContext() {
  const workspace = inject(workspaceKey)
  if (!workspace) {
    throw new Error('Workspace provider is missing')
  }
  return workspace
}
