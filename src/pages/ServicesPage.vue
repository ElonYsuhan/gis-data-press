<script setup lang="ts">
import { h } from 'vue'
import { NButton, NDropdown, NInput, NTable } from 'naive-ui'
import {
  Settings2,
  FolderOpen,
  Plus,
  Search,
  RefreshCw,
  Play,
  Square,
  MoreHorizontal,
  Copy,
  Trash2,
  Globe2,
  Pause,
} from 'lucide-vue-next'
import { useWorkspaceContext } from '../app/useWorkspace'
import { kindLabels, type Publication } from '../../shared/contracts'

const {
  api,
  snapshot,
  search,
  selected,
  busy,
  publications,
  filtered,
  current,
  available,
  base,
  serviceURL,
  status,
  icons,
  bytes,
  time,
  action,
  openService,
  openRemoval,
  openPreview,
  sample,
} = useWorkspaceContext()
function serviceMenu(publication: Publication) {
  const icon = (component: typeof Copy) => () => h(component, { size: 17, 'aria-hidden': true })
  return [
    { key: 'copy', label: '复制', icon: icon(Copy), disabled: busy.value },
    {
      key: 'toggle',
      label: publication.enabled ? '停用' : '启用',
      icon: icon(publication.enabled ? Pause : Play),
      disabled: busy.value,
    },
    { key: 'reveal', label: '打开位置', icon: icon(FolderOpen), disabled: busy.value },
    { type: 'divider', key: 'divider' },
    { key: 'remove', label: '删除', icon: icon(Trash2), disabled: busy.value },
  ]
}
function selectServiceAction(key: string, publication: Publication) {
  if (key === 'copy') {
    void action(() => api.copy(serviceURL(publication)), '服务地址已复制')
  } else if (key === 'toggle') {
    void action(() => api.togglePublication(publication.id))
  } else if (key === 'reveal') {
    void action(() => api.reveal(publication.directory))
  } else if (key === 'remove') {
    openRemoval(publication)
  }
}
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">PUBLISH YOUR DATA</div>
      <h1>服务发布</h1>
      <p>将本地资源目录发布为地图可直接访问的静态服务。</p>
    </div>
    <NButton
      class="primary"
      attr-type="button"
      type="primary"
      @click="openService()"
    >
      <Plus :size="17" />
      登记资源目录
    </NButton>
  </div>
  <div
    class="service-summary"
    aria-label="发布概览"
  >
    <span class="summary-count">
      已登记
      <strong>{{ publications.length }}</strong>
    </span>
    <span class="summary-count">
      有效
      <strong>{{ available }}</strong>
    </span>
    <span class="summary-engine">
      <span
        class="dot"
        :class="{ online: snapshot?.server.running }"
      ></span>
      Nginx · {{ snapshot?.server.running ? '运行中' : '已停止' }}
    </span>
    <span
      class="summary-address"
      :title="base"
    >
      {{ base }}
    </span>
    <NButton
      class="engine-button"
      :class="{ 'is-running': snapshot?.server.running }"
      :bordered="false"
      :disabled="busy"
      attr-type="button"
      @click="
        action(
          () => api.server(snapshot?.server.running ? 'stop' : 'start'),
          snapshot?.server.running ? '发布服务已停止' : '发布服务已启动',
        )
      "
    >
      <Square
        v-if="snapshot?.server.running"
        :size="14"
      />
      <Play
        v-else
        :size="14"
      />
      {{ snapshot?.server.running ? '停止' : '启动' }}
    </NButton>
  </div>
  <div
    v-if="snapshot?.server.error"
    class="alert error"
    role="alert"
  >
    {{ snapshot.server.error }}
  </div>
  <section class="panel service-directory-panel">
    <div class="panel-toolbar">
      <div class="section-title">
        目录映射
        <span>{{ publications.length }}</span>
      </div>
      <div class="toolbar-actions">
        <label class="search">
          <Search :size="16" />
          <NInput
            v-model:value="search"
            placeholder="搜索名称、路径…"
            :input-props="{ 'aria-label': '搜索服务名称或目录' }"
          />
        </label>
        <NButton
          class="ghost"
          :disabled="busy"
          attr-type="button"
          @click="action(() => api.refresh(), '目录状态已更新')"
        >
          <RefreshCw :size="16" />
          检查目录
        </NButton>
      </div>
    </div>
    <div class="service-list-scroll">
      <NTable
        v-if="filtered.length"
        class="service-table"
      >
        <thead>
          <tr>
            <th>服务 / 资源目录</th>
            <th>类型</th>
            <th>状态</th>
            <th>资源数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in filtered"
            :key="p.id"
            :class="{ selected: selected === p.id }"
          >
            <td>
              <div class="service-resource">
                <span
                  class="resource-icon"
                  :class="p.kind"
                  aria-hidden="true"
                >
                  <component
                    :is="icons[p.kind]"
                    :size="20"
                  />
                </span>
                <div class="service-resource-details">
                  <NButton
                    class="service-title"
                    text
                    :aria-label="'查看 ' + p.name + ' 的发布详情'"
                    :aria-expanded="selected === p.id"
                    @click="selected = selected === p.id ? '' : p.id"
                  >
                    {{ p.name }}
                  </NButton>
                  <div
                    class="service-directory"
                    :title="p.directory"
                  >
                    {{ p.directory }}
                  </div>
                </div>
              </div>
            </td>
            <td>{{ kindLabels[p.kind] }}</td>
            <td>
              <span
                class="badge"
                :class="
                  !p.valid && p.enabled
                    ? 'invalid'
                    : p.valid && p.enabled && snapshot?.server.running
                      ? 'valid'
                      : 'idle'
                "
              >
                {{ status(p) }}
              </span>
            </td>
            <td class="mono">{{ p.count.toLocaleString() }}</td>
            <td>
              <div class="row-actions">
                <NButton
                  class="service-action service-preview"
                  quaternary
                  size="small"
                  :aria-label="'预览 ' + p.name"
                  title="预览"
                  :disabled="!p.valid || !p.enabled || !snapshot?.server.running"
                  attr-type="button"
                  @click="openPreview(p)"
                >
                  <template #icon>
                    <Globe2
                      :size="18"
                      aria-hidden="true"
                    />
                  </template>
                </NButton>
                <NDropdown
                  trigger="click"
                  :options="serviceMenu(p)"
                  @select="(key: string) => selectServiceAction(key, p)"
                >
                  <NButton
                    class="service-action service-more"
                    quaternary
                    size="small"
                    :aria-label="'更多操作 ' + p.name"
                    aria-haspopup="menu"
                    attr-type="button"
                  >
                    <MoreHorizontal
                      :size="20"
                      aria-hidden="true"
                    />
                  </NButton>
                </NDropdown>
              </div>
            </td>
          </tr>
        </tbody>
      </NTable>
      <div
        v-else
        class="empty-state"
      >
        <div class="empty-art">
          <FolderOpen :size="36" />
          <span><Plus :size="14" /></span>
        </div>
        <h2>{{ search ? '没有匹配的目录' : '发布你的第一个资源目录' }}</h2>
        <p>
          选择已有瓦片、模型或图片目录，生成服务地址。
          <br />
          目录中的文件由 Nginx 直接提供给客户端。
        </p>
        <NButton
          v-if="!search"
          class="primary"
          attr-type="button"
          type="primary"
          @click="openService()"
        >
          <Plus :size="16" />
          登记资源目录
        </NButton>
      </div>
    </div>
  </section>
  <section
    v-if="current"
    class="panel detail-panel"
  >
    <div class="panel-toolbar">
      <div class="section-title">
        {{ current.name }}
        <span>目录详情</span>
      </div>
      <NButton
        class="ghost"
        attr-type="button"
        @click="openService(current)"
      >
        <Settings2 :size="15" />
        编辑映射
      </NButton>
    </div>
    <div class="detail-grid">
      <div>
        <label>URL 前缀</label>
        <code>{{ current.mount }}</code>
        <label>检查结果</label>
        <p :class="{ 'text-error': !current.valid }">{{ current.reason }}</p>
        <label>最近检查</label>
        <p>{{ time(current.indexedAt) }}</p>
        <NButton
          class="ghost"
          attr-type="button"
          @click="action(() => api.reveal(current!.directory))"
        >
          <FolderOpen :size="16" />
          打开本地目录
        </NButton>
      </div>
      <div>
        <div class="code-head">
          Cesium 接入
          <NButton
            class="ghost"
            attr-type="button"
            @click="action(() => api.copy(sample(current!)), '接入示例已复制')"
          >
            <Copy :size="14" />
            复制
          </NButton>
        </div>
        <pre>{{ sample(current) }}</pre>
      </div>
    </div>
    <details class="resource-list">
      <summary>资源索引 · 显示前 {{ current.indexed.length }} 项</summary>
      <div
        v-for="r in current.indexed"
        :key="r.path"
      >
        <code>{{ r.path }}</code>
        <span>{{ bytes(r.size) }}</span>
      </div>
    </details>
  </section>
</template>
