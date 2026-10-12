<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue'
import { NButton } from 'naive-ui'
import {
  RadioTower,
  Workflow,
  Settings2,
  ExternalLink,
  Check,
  CircleAlert,
  X,
  HardDrive,
  Clock,
  MessagesSquare,
} from 'lucide-vue-next'
import { desktop } from './services/api'
import Resources from './features/resources/Resources.vue'
import Jobs from './features/jobs/Jobs.vue'
import LanChatPage from './features/chat/LanChatPage.vue'
import ServicesPage from './pages/ServicesPage.vue'
import ProcessingPage from './pages/ProcessingPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import WorkspaceDialogs from './pages/WorkspaceDialogs.vue'
import { useWorkspace, provideWorkspace } from './app/useWorkspace'
const macDesktop = desktop && navigator.userAgent.includes('Mac')
const workspace = useWorkspace()
provideWorkspace(workspace)
const {
  api,
  tab,
  snapshot,
  busy,
  error,
  notice,
  request,
  inspection,
  publications,
  activeJobs,
  action,
  inspect,
  publishJob,
} = workspace
let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(notice, (message) => {
  clearTimeout(noticeTimer)
  if (message) {
    noticeTimer = setTimeout(() => {
      notice.value = ''
    }, 4000)
  }
})
onBeforeUnmount(() => clearTimeout(noticeTimer))
</script>
<template>
  <div
    class="app-shell"
    :class="{ 'mac-desktop': macDesktop }"
  >
    <div
      v-if="macDesktop"
      class="window-drag-region"
      aria-hidden="true"
    ></div>
    <aside class="sidebar">
      <div class="brand">
        <img
          class="brand-mark"
          src="/logo.svg"
          alt="GeoPress Logo"
        />
        <div>
          GeoPress
          <small>GIS 数据工具</small>
        </div>
        <NButton
          v-if="desktop"
          class="browser-button"
          quaternary
          :bordered="false"
          aria-label="在默认浏览器打开管理界面"
          title="在默认浏览器打开管理界面"
          attr-type="button"
          @click="action(() => api.openBrowser())"
        >
          <ExternalLink :size="16" />
        </NButton>
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
          attr-type="button"
          :class="{ active: tab === 'chat' }"
          @click="tab = 'chat'"
        >
          <MessagesSquare :size="18" />
          局域网聊天
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
    <main
      :class="{
        'process-workspace': tab === 'process',
        'services-workspace': tab === 'services',
        'resources-workspace': tab === 'resources',
        'jobs-workspace': tab === 'jobs',
        'chat-workspace': tab === 'chat',
      }"
    >
      <div class="content">
        <Resources v-if="tab === 'resources'" />
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
          @remove="(ids) => action(() => api.removeJobs(ids))"
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

        <LanChatPage v-if="tab === 'chat'" />
        <SettingsPage v-if="tab === 'settings'" />
      </div>
      <footer
        class="statusbar"
        aria-label="工作状态"
      >
        <div class="statusbar-summary">
          <span>
            <span class="dot online"></span>
            本地工作环境
          </span>
          <span>{{ snapshot?.server.running ? '发布服务运行中' : '发布服务已停止' }}</span>
          <span>进行中任务 {{ activeJobs }}</span>
          <span class="statusbar-version">GeoPress · v0.1.0</span>
        </div>
      </footer>
      <div class="workspace-notifications">
        <div
          v-if="error"
          class="alert error workspace-toast"
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
          class="alert success workspace-toast"
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
      </div>
    </main>
  </div>
  <WorkspaceDialogs />
</template>
