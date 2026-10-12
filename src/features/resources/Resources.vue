<script setup lang="ts">
import { NForm, NProgress } from 'naive-ui'
import { NButton, NInput, NCheckbox, NPagination } from 'naive-ui'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Download, Search, FolderOpen, Plus, X, RefreshCw } from 'lucide-vue-next'
import { api as managementAPI } from '../../services/api'
import BoundaryMap from './BoundaryMap.vue'
const api = managementAPI
import type { AssetKind, LocalAsset, BoundaryResult } from '../../../shared/contracts'
const types: { kind: AssetKind; name: string }[] = [
  { kind: 'imagery', name: '影像数据' },
  { kind: 'terrain', name: '地形数据' },
  { kind: 'boundary', name: '区域边界' },
  { kind: 'tileset', name: '3D Tiles' },
  { kind: 'image', name: '图片' },
  { kind: 'model', name: 'glTF' },
]
const kind = ref<AssetKind>('boundary')
const query = ref('')
const matches = ref<BoundaryResult[]>([])
const selected = ref<BoundaryResult>()
const children = ref(false)
const directory = ref('')
const url = ref('')
const filename = ref('')
const localPath = ref('')
const records = ref<LocalAsset[]>([])
const busy = ref(false)
const searching = ref(false)
const searched = ref(false)
const error = ref('')
const notice = ref('')
const levelNames: Record<string, string> = {
  country: '国家',
  province: '省级',
  city: '市级',
  district: '区县',
}
const filtered = computed(() => records.value.filter((r) => r.kind === kind.value))
const localPage = ref(1)
const pageSize = 10
const localPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const currentPage = computed(() => Math.min(localPage.value, localPages.value))
const visibleResources = computed(() =>
  filtered.value.slice((currentPage.value - 1) * pageSize, currentPage.value * pageSize),
)
let interval: ReturnType<typeof setInterval>
let polling = false
async function refresh() {
  if (polling) {
    return
  }
  polling = true
  try {
    records.value = await api.resources()
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
    await refresh()
    notice.value = message
  } catch (e) {
    error.value = String(e)
      .replace(/^.*?Error: (?:Error: )*/, '')
      .replace(/^Error invoking remote method '[^']+': /, '')
  } finally {
    busy.value = false
  }
}
async function search() {
  if (searching.value) {
    return
  }
  searching.value = true
  error.value = ''
  selected.value = undefined
  matches.value = []
  searched.value = false
  try {
    matches.value = await api.searchBoundaries(query.value)
    searched.value = true
  } catch (e) {
    error.value = String(e)
  } finally {
    searching.value = false
  }
}
async function chooseDirectory() {
  await action(async () => {
    const p = await api.choose('directory')
    if (p) {
      directory.value = p
    }
  })
}
async function chooseLocal(mode: 'file' | 'directory') {
  await action(async () => {
    const p = await api.choose(mode)
    if (p) {
      localPath.value = p
    }
  })
}
async function download() {
  await action(async () => {
    if (kind.value === 'boundary' && !selected.value) {
      throw new Error('请先选择检索结果')
    }
    await api.downloadResource({
      kind: kind.value,
      directory: directory.value,
      url: url.value,
      filename: filename.value,
      adcode: selected.value?.adcode,
      children: children.value,
    })
  }, '下载已开始，文件写入指定目录；关闭管理窗口后继续下载。')
}
function selectBoundary(result: BoundaryResult) {
  selected.value = result
  children.value = false
}
function selectType(value: AssetKind) {
  kind.value = value
  localPage.value = 1
  error.value = ''
  notice.value = ''
}
function status(r: LocalAsset) {
  return r.status === 'ready'
    ? r.exists
      ? '本地可用'
      : '文件已失效'
    : r.status === 'downloading'
      ? '下载中'
      : r.status === 'cancelled'
        ? '已取消'
        : '下载失败'
}
function size(n: number) {
  return n >= 1e6
    ? (n / 1e6).toFixed(1) + ' MB'
    : n >= 1e3
      ? (n / 1e3).toFixed(1) + ' KB'
      : n + ' B'
}
onMounted(() => {
  void refresh()
  interval = setInterval(() => void refresh(), 1500)
})
onBeforeUnmount(() => clearInterval(interval))
</script>
<template>
  <div class="resource-workspace">
    <div class="page-heading">
      <div>
        <h1>资源下载</h1>
        <p>检索在线资源、下载到指定目录，或登记已有本地文件。</p>
      </div>
      <span class="outline-tag">文件由本地目录管理</span>
    </div>
    <div
      class="resource-tabs"
      role="group"
      aria-label="资源类型"
    >
      <NButton
        v-for="t in types"
        :key="t.kind"
        :class="{ chosen: kind === t.kind }"
        :aria-pressed="kind === t.kind"
        attr-type="button"
        @click="selectType(t.kind)"
      >
        {{ t.name }}
      </NButton>
    </div>
    <div
      v-if="error"
      class="alert error"
      role="alert"
    >
      {{ error }}
      <NButton
        aria-label="关闭错误"
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
      {{ notice }}
    </div>
    <div class="resource-columns">
      <section class="panel acquisition-panel">
        <template v-if="kind === 'boundary'">
          <div class="section-title">
            区域边界
            <span>DataV</span>
          </div>
          <NForm
            class="boundary-search"
            @submit.prevent="search"
          >
            <NInput
              v-model:value="query"
              placeholder="输入地名或代码，例如 西安、朝阳区、610100"
              :input-props="{ 'aria-label': '地名或行政区代码', required: true, maxlength: '80' }"
            />
            <NButton
              class="primary"
              :disabled="searching"
              attr-type="submit"
              type="primary"
            >
              <Search :size="15" />
              {{ searching ? '检索中…' : '检索' }}
            </NButton>
          </NForm>
          <p class="field-help">
            支持国家、省、市、区县；同名地区通过上级区划区分。乡镇、村界暂无数据。
          </p>
          <BoundaryMap
            :selected="selected"
            @select="selectBoundary"
          />
          <div
            v-if="searched || searching"
            class="boundary-results boundary-search-matches"
            aria-label="地名检索结果"
            :aria-busy="searching"
          >
            <NButton
              v-for="r in matches"
              :key="r.adcode"
              :class="{ chosen: selected?.adcode === r.adcode }"
              :aria-pressed="selected?.adcode === r.adcode"
              attr-type="button"
              @click="selectBoundary(r)"
            >
              <span>
                <strong>{{ r.name }}</strong>
                <small>{{ r.ancestors || '国家边界' }}</small>
              </span>
              <span>{{ levelNames[r.level] || r.level }} · {{ r.adcode }}</span>
            </NButton>
            <div
              v-if="!matches.length"
              class="boundary-placeholder"
            >
              {{
                searching
                  ? '正在读取 DataV 地名索引…'
                  : searched
                    ? '没有匹配结果，请换一个地名或行政区代码。'
                    : '检索地名后，选择需要下载的区域。'
              }}
            </div>
          </div>
        </template>
        <template v-else>
          <div class="section-title">
            文件直链下载
            <span>{{ types.find((t) => t.kind === kind)?.name }}</span>
          </div>
          <p class="resource-description">
            {{
              kind === 'imagery'
                ? '下载 GeoTIFF、影像压缩包或已有瓦片数据。'
                : kind === 'terrain'
                  ? '下载 DEM GeoTIFF 或已有地形压缩包。'
                  : kind === 'tileset'
                    ? '下载完整 3D Tiles 资源压缩包。'
                    : kind === 'model'
                      ? '下载 GLB 或包含 glTF、纹理和 bin 的完整压缩包。'
                      : '下载 PNG、JPG、SVG 等图片文件。'
            }}
            此入口下载单个文件，不递归抓取瓦片或模型依赖。
          </p>
          <label for="resource-url">HTTP / HTTPS 文件地址</label>
          <NInput
            v-model:value="url"
            placeholder="https://…"
            :input-props="{ id: 'resource-url' }"
          />
          <label for="resource-filename">保存文件名（含扩展名）</label>
          <NInput
            v-model:value="filename"
            placeholder="例如 imagery.tif、terrain.tif 或 scene.zip"
            :input-props="{ id: 'resource-filename', maxlength: '180' }"
          />
        </template>
        <NForm
          class="resource-destination"
          @submit.prevent="download"
        >
          <div class="download-options-heading">
            <label for="download-directory">
              {{
                kind === 'boundary'
                  ? selected?.name
                    ? selected.name + ' · GeoJSON'
                    : '请先检索并选择区域'
                  : '压缩包下载后请自行解压，登记完整目录。'
              }}
            </label>
            <label
              v-if="kind === 'boundary' && selected && selected.level !== 'district'"
              class="checkbox"
              title="下载下一级行政区边界集合"
            >
              <NCheckbox v-model:checked="children" />
              包含下一级边界
            </label>
          </div>
          <div class="download-directory-row">
            <NInput
              v-model:value="directory"
              class="directory-picker"
              placeholder="选择下载目录，或输入绝对路径"
              :input-props="{ id: 'download-directory', required: true }"
            >
              <template #suffix>
                <NButton
                  quaternary
                  class="directory-picker-button"
                  :disabled="busy"
                  attr-type="button"
                  aria-label="选择下载目录"
                  title="选择目录"
                  @click="chooseDirectory"
                >
                  <FolderOpen :size="18" />
                </NButton>
              </template>
            </NInput>
            <NButton
              class="primary"
              :disabled="
                busy || !directory || (kind === 'boundary' ? !selected : !url || !filename)
              "
              attr-type="submit"
              type="primary"
            >
              <Download :size="16" />
              下载到本地
            </NButton>
          </div>
        </NForm>
      </section>
      <section class="panel local-resources-panel">
        <div class="section-title">
          本地资源
          <NButton
            class="ghost"
            :disabled="busy"
            attr-type="button"
            @click="refresh"
          >
            <RefreshCw :size="14" />
            检查
          </NButton>
        </div>
        <NForm
          class="resource-register"
          @submit.prevent="
            action(
              () => api.registerResource(kind, localPath),
              '本地资源已登记，文件保留在原目录。',
            )
          "
        >
          <label for="local-resource-path">登记已有文件或目录</label>
          <NInput
            v-model:value="localPath"
            placeholder="本地绝对路径"
            :input-props="{ id: 'local-resource-path', required: true }"
          />
          <div>
            <NButton
              class="ghost"
              :disabled="busy"
              attr-type="button"
              @click="chooseLocal('file')"
            >
              选择文件
            </NButton>
            <NButton
              class="ghost"
              :disabled="busy"
              attr-type="button"
              @click="chooseLocal('directory')"
            >
              选择目录
            </NButton>
            <NButton
              class="primary"
              :disabled="busy || !localPath"
              attr-type="submit"
              type="primary"
            >
              <Plus :size="14" />
              登记
            </NButton>
          </div>
        </NForm>
        <div class="local-resource-list">
          <table
            class="local-resource-table"
            aria-label="本地资源"
          >
            <thead>
              <tr>
                <th scope="col">文件 / 路径</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in visibleResources"
                :key="r.id"
              >
                <td>
                  <strong :title="r.name">{{ r.name }}</strong>
                  <code :title="r.path">{{ r.path }}</code>
                  <small v-if="r.status === 'downloading'">
                    {{ size(r.received) }} / {{ r.size ? size(r.size) : '大小未知' }}
                  </small>
                  <NProgress
                    v-if="r.status === 'downloading' && r.size"
                    type="line"
                    :percentage="Math.max(0, Math.min(100, (r.received / r.size) * 100))"
                    :show-indicator="false"
                    aria-label="下载进度"
                  />
                  <p
                    v-if="r.error"
                    class="text-error"
                  >
                    {{ r.error }}
                  </p>
                </td>
                <td>
                  <span
                    class="badge"
                    :class="
                      r.status === 'ready' && r.exists
                        ? 'valid'
                        : r.status === 'failed' || r.exists === false
                          ? 'invalid'
                          : 'idle'
                    "
                  >
                    {{ status(r) }}
                  </span>
                </td>
                <td>
                  <NButton
                    v-if="r.status === 'downloading'"
                    class="icon-button"
                    attr-type="button"
                    title="取消下载"
                    :aria-label="'取消下载 ' + r.name"
                    @click="action(() => api.cancelDownload(r.id))"
                  >
                    <X :size="18" />
                  </NButton>
                  <NButton
                    v-else
                    :disabled="!r.exists"
                    class="icon-button"
                    attr-type="button"
                    title="打开目录"
                    :aria-label="'打开目录 ' + r.name"
                    @click="action(() => api.reveal(r.path))"
                  >
                    <FolderOpen :size="18" />
                  </NButton>
                </td>
              </tr>
              <tr v-if="!filtered.length">
                <td
                  colspan="3"
                  class="local-resource-empty"
                >
                  该类型暂无本地资源
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="local-resource-pagination">
          <span>共 {{ filtered.length }} 项</span>
          <NPagination
            :page="currentPage"
            :page-count="localPages"
            :page-slot="5"
            @update:page="localPage = $event"
          />
        </div>
      </section>
    </div>
  </div>
</template>
