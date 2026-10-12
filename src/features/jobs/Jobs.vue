<script setup lang="ts">
import { NProgress } from 'naive-ui'
import { NButton } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import {
  Clock,
  FolderOpen,
  RadioTower,
  RefreshCw,
  Square,
  Plus,
  Settings2,
  FileText,
  Trash2,
  Search,
} from 'lucide-vue-next'
import type { Job, Settings } from '../../../shared/contracts'
const props = defineProps<{ jobs: Job[]; settings?: Settings; busy: boolean }>()
const emit = defineEmits<{
  create: []
  settings: []
  cancel: [id: string]
  remove: [ids: string[]]
  publish: [job: Job]
  reveal: [path: string]
  retry: [job: Job]
}>()
const names: Record<string, string> = {
  imagery: '影像切片',
  terrain: '地形切片',
  osgb: 'OSGB → 3D Tiles',
}
const labels: Record<string, string> = {
  queued: '排队',
  running: '处理中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}
const counts = computed(() => ({
  running: props.jobs.filter((j) => j.status === 'running').length,
  queued: props.jobs.filter((j) => j.status === 'queued').length,
  done: props.jobs.filter((j) => j.status === 'succeeded').length,
}))
const query = ref('')
const status = ref('')
const page = ref(1)
const pageSize = ref(10)
const selected = ref<string[]>([])
const removable = (job: Job) => !['running', 'queued'].includes(job.status)
const filtered = computed(() =>
  props.jobs.filter(
    (job) =>
      (!status.value || job.status === status.value) &&
      [
        job.request.input,
        ...(job.request.inputs ?? []),
        job.request.output,
        names[job.request.kind],
        labels[job.status],
      ]
        .join(' ')
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()),
  ),
)
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
)
const selectable = computed(() => visible.value.filter(removable).map((job) => job.id))
const allSelected = computed(
  () => selectable.value.length > 0 && selectable.value.every((id) => selected.value.includes(id)),
)
watch([query, status, pageSize], () => {
  page.value = 1
  selected.value = []
})
watch(
  () => props.jobs,
  () => {
    page.value = Math.min(page.value, pages.value)
    selected.value = selected.value.filter((id) =>
      props.jobs.some((job) => job.id === id && removable(job)),
    )
  },
)
function toggle(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((value) => value !== id)
    : [...selected.value, id]
}
function togglePage() {
  selected.value = allSelected.value
    ? selected.value.filter((id) => !selectable.value.includes(id))
    : [...new Set([...selected.value, ...selectable.value])]
}
function filename(p: string) {
  return p.split(/[\\/]/).pop() || p
}
function elapsed(job: Job) {
  if (!job.startedAt) {
    return '尚未开始'
  }
  const seconds = Math.max(
    0,
    Math.floor(
      ((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt)) /
        1000,
    ),
  )
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}小时 ${Math.floor((seconds % 3600) / 60)}分`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`
      : `${seconds}秒`
}
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>任务中心</h1>
      <p>处理进度、耗时与单文件成果。</p>
    </div>
    <NButton
      class="primary"
      attr-type="button"
      type="primary"
      @click="emit('create')"
    >
      <Plus :size="16" />
      新建任务
    </NButton>
  </div>
  <div class="job-summary">
    <div>
      <span class="dot online"></span>
      {{ counts.running }} 个运行
      <span>{{ counts.queued }} 个排队</span>
      <span>{{ counts.done }} 个完成</span>
    </div>
    <NButton
      class="ghost"
      attr-type="button"
      @click="emit('settings')"
    >
      <Settings2 :size="14" />
      并发 {{ settings?.taskConcurrency ?? 2 }} · 并行预算
      {{ settings?.workerBudget ?? 4 }}
    </NButton>
  </div>
  <div class="jobs-toolbar">
    <div class="jobs-filters">
      <label class="jobs-search">
        <Search :size="16" />
        <input
          v-model="query"
          aria-label="检索任务"
          placeholder="搜索任务名称或路径"
        />
      </label>
      <select
        v-model="status"
        aria-label="筛选任务状态"
      >
        <option value="">全部状态</option>
        <option
          v-for="(label, value) in labels"
          :key="value"
          :value="value"
        >
          {{ label }}
        </option>
      </select>
    </div>
    <div class="jobs-bulk-actions">
      <label class="jobs-select">
        <input
          type="checkbox"
          :checked="allSelected"
          :disabled="!selectable.length"
          @change="togglePage"
        />
        本页全选
      </label>
      <NButton
        class="jobs-delete"
        type="error"
        secondary
        :disabled="busy || !selected.length"
        @click="emit('remove', [...selected])"
      >
        <Trash2 :size="15" />
        删除记录{{ selected.length ? `（${selected.length}）` : '' }}
      </NButton>
    </div>
  </div>
  <div class="jobs-list">
    <div
      v-if="!filtered.length"
      class="panel empty-state"
    >
      <FileText :size="36" />
      <h2>{{ jobs.length ? '没有匹配的任务' : '还没有加工任务' }}</h2>
      <p>选择本地 TIFF 或 OSGB 数据开始加工。</p>
    </div>
    <article
      v-for="job in visible"
      :key="job.id"
      class="panel compact-job"
      :class="job.status"
    >
      <div class="compact-job-head">
        <div>
          <input
            type="checkbox"
            :aria-label="`选择任务 ${filename(job.request.input)}`"
            :checked="selected.includes(job.id)"
            :disabled="!removable(job) || busy"
            @change="toggle(job.id)"
          />
          <strong :title="job.request.input">
            {{ filename(job.request.input)
            }}{{
              (job.request.inputs?.length ?? 1) > 1
                ? ` 等 ${job.request.inputs?.length} 个输入`
                : ''
            }}
          </strong>
          <span class="job-kind">{{ names[job.request.kind] }}</span>
          <span
            class="badge"
            :class="
              job.status === 'succeeded' ? 'valid' : job.status === 'failed' ? 'invalid' : 'idle'
            "
          >
            {{ labels[job.status] }}
          </span>
        </div>
        <div class="compact-job-actions">
          <NButton
            v-if="['running', 'queued'].includes(job.status)"
            class="ghost"
            :disabled="busy"
            attr-type="button"
            @click="emit('cancel', job.id)"
          >
            <Square :size="13" />
            取消
          </NButton>
          <template v-if="job.status === 'succeeded'">
            <NButton
              class="ghost"
              attr-type="button"
              @click="emit('reveal', job.request.output)"
            >
              <FolderOpen :size="14" />
              成果
            </NButton>
            <NButton
              class="primary"
              attr-type="button"
              type="primary"
              @click="emit('publish', job)"
            >
              <RadioTower :size="14" />
              发布
            </NButton>
          </template>
          <NButton
            v-if="['failed', 'cancelled', 'interrupted'].includes(job.status)"
            class="ghost"
            attr-type="button"
            @click="emit('retry', job)"
          >
            <RefreshCw :size="14" />
            继续 / 重新配置
          </NButton>
          <NButton
            v-if="removable(job)"
            quaternary
            type="error"
            :disabled="busy"
            :aria-label="`删除任务记录 ${filename(job.request.input)}`"
            title="删除记录，保留成果"
            @click="emit('remove', [job.id])"
          >
            <Trash2 :size="16" />
          </NButton>
        </div>
      </div>
      <div class="job-progress-caption">
        <span
          :title="job.stage"
          :class="{ 'text-error': job.status === 'failed' }"
        >
          {{ job.stage }}
        </span>
        <strong>
          {{
            job.status === 'running'
              ? job.progress
                ? Math.floor(job.progress.percent) + '% · 当前阶段'
                : '正在计算…'
              : job.status === 'succeeded'
                ? '100%'
                : ''
          }}
        </strong>
      </div>
      <NProgress
        v-if="job.progress || job.status !== 'running'"
        type="line"
        :percentage="
          Math.max(
            0,
            Math.min(
              100,
              ((job.status === 'succeeded' ? 100 : (job.progress?.percent ?? 0)) / 100) * 100,
            ),
          )
        "
        :show-indicator="false"
        :aria-label="names[job.request.kind] + '处理进度'"
      />
      <div
        v-else
        class="job-progress-indeterminate"
        role="progressbar"
        :aria-label="job.stage + '，引擎尚未返回百分比'"
      >
        <span></span>
      </div>
      <div class="compact-job-meta">
        <span>
          <Clock :size="12" />
          {{ elapsed(job) }}
        </span>
        <span v-if="job.request.kind !== 'osgb'">
          {{ job.request.minZoom }}–{{ job.request.maxZoom }} 级
        </span>
        <span>
          {{
            job.status === 'running'
              ? '实际并行 ' + (job.effectiveWorkers ?? job.request.workers)
              : '请求并行 ' + job.request.workers
          }}
        </span>
        <code :title="job.request.output">{{ job.request.output }}</code>
      </div>
      <div
        v-if="job.progress?.label && job.status === 'running'"
        class="job-progress-label"
      >
        {{ job.progress.label }}
      </div>
      <details class="compact-job-details">
        <summary>路径与引擎日志 · {{ job.logs.length }} 条</summary>
        <div class="job-paths">
          <span>输入</span>
          <code>{{ job.request.input }}</code>
          <span>输出</span>
          <code>{{ job.request.output }}</code>
        </div>
        <p
          v-if="job.error"
          class="text-error"
        >
          {{ job.error }}
        </p>
        <pre class="log-output">{{ job.logs.join('\n') || '引擎尚未输出日志' }}</pre>
      </details>
    </article>
  </div>
  <div class="jobs-pagination">
    <span>
      共 {{ filtered.length }} 条{{ selected.length ? ` · 已选 ${selected.length} 条` : '' }}
    </span>
    <select
      v-model.number="pageSize"
      aria-label="每页任务数"
    >
      <option :value="10">10 条 / 页</option>
      <option :value="20">20 条 / 页</option>
      <option :value="50">50 条 / 页</option>
    </select>
    <NButton
      :disabled="page <= 1"
      @click="page--"
    >
      上一页
    </NButton>
    <span>{{ page }} / {{ pages }}</span>
    <NButton
      :disabled="page >= pages"
      @click="page++"
    >
      下一页
    </NButton>
  </div>
</template>
