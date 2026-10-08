<script setup lang="ts">
import { NButton } from 'naive-ui'
import {
  RadioTower,
  Workflow,
  Settings2,
  ExternalLink,
  ChevronRight,
  Check,
  CircleAlert,
  X,
  HardDrive,
  Clock,
} from 'lucide-vue-next'
import { desktop } from './services/api'
import Resources from './features/resources/Resources.vue'
import Jobs from './features/jobs/Jobs.vue'
import ServicesPage from './pages/ServicesPage.vue'
import ProcessingPage from './pages/ProcessingPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import WorkspaceDialogs from './pages/WorkspaceDialogs.vue'
import { useWorkspace, provideWorkspace } from './app/useWorkspace'
import type { ServiceKind } from '../shared/contracts'
const workspace = useWorkspace()
provideWorkspace(workspace)
const {
  api,
  tab,
  snapshot,
  busy,
  error,
  notice,
  inspection,
  form,
  request,
  publications,
  activeJobs,
  action,
  inspect,
  openService,
  publishJob,
} = workspace
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <img
          class="brand-mark"
          src="/logo.svg"
          alt="GeoPress Logo"
        />
        <div>
          GeoPress
          <small>数据加工与目录发布</small>
        </div>
        <NButton
          v-if="desktop"
          class="browser-button"
          aria-label="在默认浏览器打开管理界面"
          title="在默认浏览器打开管理界面"
          attr-type="button"
          @click="action(() => api.openBrowser())"
        >
          <ExternalLink :size="16" />
        </NButton>
      </div>
      <div class="workspace-label">
        工作空间
        <span>LOCAL</span>
      </div>
      <nav aria-label="主导航">
        <NButton
          quaternary
          :bordered="false"
          :class="{ active: tab === 'services' }"
          attr-type="button"
          @click="tab = 'services'"
        >
          <RadioTower :size="19" />
          服务发布
          <span class="nav-count">{{ publications.length }}</span>
        </NButton>
        <NButton
          quaternary
          :bordered="false"
          :class="{ active: tab === 'resources' }"
          attr-type="button"
          @click="tab = 'resources'"
        >
          <HardDrive :size="19" />
          资源下载
        </NButton>
        <NButton
          quaternary
          :bordered="false"
          :class="{ active: tab === 'process' }"
          attr-type="button"
          @click="tab = 'process'"
        >
          <Workflow :size="19" />
          数据处理
        </NButton>
        <NButton
          quaternary
          :bordered="false"
          :class="{ active: tab === 'jobs' }"
          attr-type="button"
          @click="tab = 'jobs'"
        >
          <Clock :size="19" />
          任务中心
          <span
            v-if="activeJobs"
            class="nav-count"
          >
            {{ activeJobs }}
          </span>
        </NButton>
        <NButton
          quaternary
          :bordered="false"
          :class="{ active: tab === 'settings' }"
          attr-type="button"
          @click="tab = 'settings'"
        >
          <Settings2 :size="19" />
          引擎与设置
        </NButton>
      </nav>
      <div class="sidebar-bottom">
        <span
          class="dot"
          :class="{ online: snapshot?.server.running }"
        ></span>
        {{ snapshot?.server.running ? 'Nginx 正在运行' : '发布服务未启动' }}
        <small>v0.1.0 · Desktop Edition</small>
      </div>
    </aside>
    <main :class="{ 'process-workspace': tab === 'process' }">
      <header class="topbar">
        <div class="breadcrumb">
          工作空间
          <ChevronRight :size="14" />
          {{
            tab === 'resources'
              ? '资源下载'
              : tab === 'services'
                ? '服务发布'
                : tab === 'process'
                  ? '数据处理'
                  : tab === 'jobs'
                    ? '任务中心'
                    : '引擎与设置'
          }}
        </div>
        <span class="local-tag">
          <span class="dot online"></span>
          本地工作环境
        </span>
      </header>
      <div class="content">
        <div
          v-if="error"
          class="alert error"
          role="alert"
        >
          <CircleAlert :size="18" />
          <span>{{ error }}</span>
          <NButton
            class="alert-close"
            circle
            quaternary
            aria-label="关闭错误提示"
            attr-type="button"
            @click="error = ''"
          >
            <X :size="16" />
          </NButton>
        </div>
        <div
          v-if="notice"
          class="alert success"
          role="status"
        >
          <Check :size="18" />
          <span>{{ notice }}</span>
          <NButton
            class="alert-close"
            circle
            quaternary
            aria-label="关闭操作提示"
            attr-type="button"
            @click="notice = ''"
          >
            <X :size="16" />
          </NButton>
        </div>
        <Resources
          v-if="tab === 'resources'"
          @process="
            (kind, path) => {
              request.kind = kind
              request.input = path
              request.inputs = [path]
              request.outputFormat = 'package'
              inspection = undefined
              tab = 'process'
            }
          "
          @publish="
            async (kind, path) => {
              await openService()
              form.kind = kind as ServiceKind
              form.directory = path
              form.name = path.split(/[\\/]/).pop() || '本地资源'
            }
          "
        />
        <ServicesPage v-if="tab === 'services'" />

        <ProcessingPage v-if="tab === 'process'" />

        <Jobs
          v-if="tab === 'jobs'"
          :jobs="snapshot?.jobs ?? []"
          :settings="snapshot?.settings"
          :busy="busy"
          @create="tab = 'process'"
          @settings="tab = 'settings'"
          @cancel="(id) => action(() => api.cancel(id))"
          @reveal="(path) => action(() => api.reveal(path))"
          @publish="publishJob"
          @retry="
            async (job) => {
              request = { ...job.request }
              inspection = undefined
              tab = 'process'
              await inspect()
            }
          "
        />

        <SettingsPage v-if="tab === 'settings'" />
      </div>
    </main>
  </div>
  <WorkspaceDialogs />
</template>
