<script setup lang="ts">
import { NProgress } from 'naive-ui'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import {
  Clock,
  FolderOpen,
  RadioTower,
  RefreshCw,
  Square,
  Plus,
  Settings2,
  FileText,
} from 'lucide-vue-next'
import type { Job, Settings } from '../../../shared/contracts'
const props = defineProps<{ jobs: Job[]; settings?: Settings; busy: boolean }>()
const emit = defineEmits<{
  create: []
  settings: []
  cancel: [id: string]
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
  <div
    v-if="!jobs.length"
    class="panel empty-state"
  >
    <FileText :size="36" />
    <h2>还没有加工任务</h2>
    <p>选择本地 TIFF 或 OSGB 数据开始加工。</p>
  </div>
  <article
    v-for="job in jobs"
    :key="job.id"
    class="panel compact-job"
    :class="job.status"
  >
    <div class="compact-job-head">
      <div>
        <strong :title="job.request.input">
          {{ filename(job.request.input)
          }}{{
            (job.request.inputs?.length ?? 1) > 1 ? ` 等 ${job.request.inputs?.length} 个输入` : ''
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
</template>
