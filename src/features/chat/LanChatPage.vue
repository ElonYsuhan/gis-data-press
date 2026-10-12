<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { NButton, NProgress } from 'naive-ui'
import {
  Search,
  Send,
  Paperclip,
  FolderOpen,
  Image,
  UserRound,
  RefreshCw,
  X,
  Download,
} from 'lucide-vue-next'
import { api, desktop } from '../../services/api'
import type { LanSnapshot, LanTransfer } from '../../../shared/lan'
const state = ref<LanSnapshot>()
const selected = ref('')
const query = ref('')
const text = ref('')
const newName = ref('')
const error = ref('')
const busy = ref(false)
const messagesBox = ref<HTMLElement>()
const atBottom = ref(true)
function updateScroll() {
  const el = messagesBox.value
  atBottom.value = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
function scrollBottom() {
  if (atBottom.value) {
    messagesBox.value?.scrollTo({ top: messagesBox.value.scrollHeight })
  }
}
const previews = ref<Record<string, string>>({})
const requestedPreviews = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined
let polling = false
const peer = computed(() => state.value?.peers.find((p) => p.id === selected.value))
const peers = computed(
  () =>
    state.value?.peers.filter(
      (p) => p.online && `${p.name} ${p.ip}`.includes(query.value.trim()),
    ) ?? [],
)
const timeline = computed(() =>
  [
    ...(state.value?.messages
      .filter((m) => m.peerId === selected.value)
      .map((m) => ({ ...m, kind: 'text' as const })) ?? []),
    ...(state.value?.transfers
      .filter((t) => t.peerId === selected.value)
      .map((t) => ({ ...t, kind: 'transfer' as const })) ?? []),
  ].sort((a, b) => a.time.localeCompare(b.time)),
)
const statusNames: Record<LanTransfer['status'], string> = {
  offered: '等待接收',
  transferring: '传输中',
  done: '已完成',
  failed: '传输失败',
  cancelled: '已取消',
  rejected: '已拒绝',
}
function bytes(n: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (n >= 1024 && index < units.length - 1) {
    n /= 1024
    index++
  }
  return `${n.toFixed(index ? 1 : 0)} ${units[index]}`
}
function time(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
async function poll() {
  if (polling) {
    return
  }
  polling = true
  try {
    const nearBottom = atBottom.value
    state.value = await api.lanSnapshot()
    if (!selected.value) {
      selected.value = peers.value[0]?.id ?? ''
    }
    for (const transfer of state.value.transfers) {
      if (
        (transfer.status === 'done' || transfer.direction === 'out') &&
        /\.(png|jpe?g|gif|webp|bmp)$/i.test(transfer.name) &&
        !requestedPreviews.has(transfer.id)
      ) {
        requestedPreviews.add(transfer.id)
        void api
          .lanPreview(transfer.id)
          .then((url) => {
            if (url) {
              previews.value[transfer.id] = url
            }
          })
          .catch(() => {})
      }
    }
    if (nearBottom) {
      await nextTick()
      messagesBox.value?.scrollTo({ top: messagesBox.value.scrollHeight })
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    polling = false
  }
}
async function act(work: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await work()
    await poll()
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}
function enter(event: KeyboardEvent) {
  if (event.isComposing) {
    return
  }
  event.preventDefault()
  void send()
}
async function switchUser(event: Event) {
  await act(() => api.lanSwitchUser((event.target as HTMLSelectElement).value))
  selected.value = ''
  text.value = ''
  requestedPreviews.clear()
  previews.value = {}
}
async function createUser() {
  await act(async () => {
    await api.lanCreateUser(newName.value)
    newName.value = ''
  })
}
async function send() {
  const value = text.value
  if (!value.trim() || !peer.value?.online || busy.value) {
    return
  }
  await act(async () => {
    await api.lanText(selected.value, value)
    text.value = ''
  })
}
async function attach(folder: boolean) {
  await act(async () => {
    const paths = await api.lanChoose(folder)
    if (paths.length) {
      await api.lanOffer(selected.value, paths)
    }
  })
}
async function accept(transfer: LanTransfer) {
  await act(async () => {
    const directory = await api.choose('directory')
    if (directory) {
      await api.lanAccept(transfer.id, directory)
    }
  })
}
function cancelTransfer(id: string) {
  return act(() => api.lanCancel(id))
}
function revealTransfer(value: string) {
  return act(() => api.reveal(value))
}
function select(id: string) {
  atBottom.value = true
  selected.value = id
  error.value = ''
  void nextTick(() => messagesBox.value?.scrollTo({ top: messagesBox.value.scrollHeight }))
}
onMounted(() => {
  if (desktop) {
    void poll()
    timer = setInterval(() => void poll(), 1000)
  }
})
onBeforeUnmount(() => clearInterval(timer))
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>局域网聊天</h1>
      <p>
        在线直传 · 本机 {{ state?.self.name ?? '—' }}
        <span v-if="state?.self.ips.length">（{{ state.self.ips.join(' / ') }}）</span>
      </p>
    </div>
    <span class="lan-online-count">
      <span class="dot online"></span>
      {{ peers.length }} 位在线
    </span>
  </div>
  <div
    v-if="!desktop"
    class="panel empty-state"
  >
    请在桌面软件中使用局域网聊天。
  </div>
  <div
    v-else
    class="lan-chat"
  >
    <aside class="lan-people">
      <div class="lan-people-heading">
        在线用户
        <NButton
          quaternary
          circle
          aria-label="刷新在线用户"
          @click="poll"
        >
          <RefreshCw :size="16" />
        </NButton>
      </div>
      <div class="lan-user-controls">
        <select
          aria-label="当前聊天用户"
          :value="state?.self.id"
          @change="switchUser"
        >
          <option
            v-for="user in state?.users"
            :key="user.id"
            :value="user.id"
          >
            {{ user.name }}
          </option>
        </select>
        <form @submit.prevent="createUser">
          <input
            v-model="newName"
            maxlength="32"
            aria-label="新用户名称"
            placeholder="新用户名称"
          />
          <NButton
            attr-type="submit"
            :disabled="busy || !newName.trim()"
          >
            创建
          </NButton>
        </form>
      </div>
      <label class="lan-search">
        <Search :size="15" />
        <input
          v-model="query"
          aria-label="搜索局域网用户"
          placeholder="搜索用户或 IP"
        />
      </label>
      <div class="lan-peer-list">
        <button
          v-for="person in peers"
          :key="person.id"
          :data-peer-id="person.id"
          :class="{ active: selected === person.id }"
          @click="select(person.id)"
        >
          <span class="lan-avatar"><UserRound :size="21" /></span>
          <span>
            <strong>{{ person.name }}</strong>
            <small>{{ person.ip }}</small>
          </span>
          <span class="dot online"></span>
        </button>
        <p
          v-if="!peers.length"
          class="lan-no-peers"
        >
          等待局域网用户上线
          <br />
          <small>同一局域网内打开 GeoPress 即可发现</small>
        </p>
      </div>
    </aside>
    <section
      class="lan-conversation"
      aria-label="聊天内容"
    >
      <template v-if="selected">
        <header class="lan-conversation-header">
          <span class="lan-avatar"><UserRound :size="20" /></span>
          <div>
            <strong>{{ peer?.name ?? '离线用户' }}</strong>
            <small>{{ peer?.ip }} · {{ peer?.online ? '在线' : '离线，无法传输' }}</small>
          </div>
        </header>
        <div
          ref="messagesBox"
          class="lan-messages"
          role="log"
          aria-label="消息记录"
          aria-live="polite"
          @scroll="updateScroll"
        >
          <div
            v-for="item in timeline"
            :key="item.id"
            class="lan-message"
            :class="item.direction"
          >
            <span class="lan-message-time">
              {{ item.direction === 'out' ? '我' : peer?.name }} · {{ time(item.time) }}
            </span>
            <div
              v-if="item.kind === 'text'"
              class="lan-text"
            >
              {{ item.text }}
            </div>
            <div
              v-else
              class="lan-file"
            >
              <img
                v-if="previews[item.id]"
                :src="previews[item.id]"
                :alt="item.name"
                class="lan-image-preview"
                @load="scrollBottom"
              />
              <div class="lan-file-title">
                <FolderOpen :size="22" />
                <strong>{{ item.name }}</strong>
              </div>
              <small>{{ item.files }} 个文件 · {{ bytes(item.size) }}</small>
              <NProgress
                v-if="item.status === 'transferring'"
                type="line"
                :percentage="
                  item.size ? Math.min(100, Math.floor((item.received / item.size) * 100)) : 0
                "
                :show-indicator="false"
              />
              <div class="lan-transfer-state">
                <span>{{ statusNames[item.status] }}</span>
                <span v-if="item.status === 'transferring'">
                  {{ bytes(item.received) }}
                  <template v-if="item.speed">· {{ bytes(item.speed) }}/s</template>
                </span>
              </div>
              <p
                v-if="item.error"
                class="lan-transfer-error"
              >
                {{ item.error }}
              </p>
              <div class="lan-file-actions">
                <NButton
                  v-if="item.direction === 'in' && ['offered', 'failed'].includes(item.status)"
                  type="primary"
                  size="small"
                  :disabled="busy || !peer?.online"
                  @click="accept(item)"
                >
                  <Download :size="14" />
                  {{ item.status === 'failed' ? '继续接收' : '接收' }}
                </NButton>
                <NButton
                  v-if="['offered', 'transferring', 'failed'].includes(item.status)"
                  size="small"
                  :disabled="busy"
                  @click="cancelTransfer(item.id)"
                >
                  <X :size="14" />
                  {{ item.direction === 'in' && item.status === 'offered' ? '拒绝' : '取消' }}
                </NButton>
                <NButton
                  v-if="item.direction === 'in' && item.status === 'done' && item.path"
                  size="small"
                  @click="revealTransfer(item.path!)"
                >
                  <FolderOpen :size="14" />
                  打开目录
                </NButton>
              </div>
            </div>
          </div>
          <div
            v-if="!timeline.length"
            class="lan-empty-conversation"
          >
            开始聊天，或发送文件给 {{ peer?.name }}
          </div>
        </div>
        <div class="lan-composer">
          <div class="lan-attachments">
            <NButton
              quaternary
              :disabled="busy || !peer?.online"
              @click="attach(false)"
            >
              <Image :size="17" />
              图片
            </NButton>
            <NButton
              quaternary
              :disabled="busy || !peer?.online"
              @click="attach(false)"
            >
              <Paperclip :size="17" />
              文件 / 压缩包
            </NButton>
            <NButton
              quaternary
              :disabled="busy || !peer?.online"
              @click="attach(true)"
            >
              <FolderOpen :size="17" />
              文件夹
            </NButton>
          </div>
          <textarea
            v-model="text"
            aria-label="输入聊天消息"
            placeholder="输入消息…"
            :disabled="!peer?.online"
            @keydown.enter.exact="enter"
          />
          <div class="lan-send-row">
            <small>Enter 发送 · Shift + Enter 换行</small>
            <NButton
              type="primary"
              :disabled="busy || !text.trim() || !peer?.online"
              @click="send"
            >
              <Send :size="16" />
              发送
            </NButton>
          </div>
        </div>
      </template>
      <div
        v-else
        class="lan-empty-conversation"
      >
        <UserRound :size="38" />
        <strong>选择在线用户开始聊天</strong>
        <span>文件直传，不设置文件大小上限</span>
      </div>
    </section>
  </div>
  <p
    v-if="error || state?.error"
    class="lan-error"
    role="alert"
  >
    {{ error || state?.error }}
  </p>
</template>
