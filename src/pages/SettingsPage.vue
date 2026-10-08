<script setup lang="ts">
import { NButton, NInputNumber, NSelect, NInput } from 'naive-ui'
import { FolderOpen, Check } from 'lucide-vue-next'
import { useWorkspaceContext } from '../app/useWorkspace'

const { tab, snapshot, busy, settings, settingsDirty, action, saveSettings, selectEngine } =
  useWorkspaceContext()
</script>
<template>
  <template v-if="tab === 'settings' && settings">
    <div class="page-heading">
      <div>
        <div class="eyebrow">RUNTIME & NETWORK</div>
        <h1>引擎与设置</h1>
        <p>配置本地引擎和静态服务监听方式。</p>
      </div>
      <NButton
        class="primary"
        :disabled="busy"
        attr-type="button"
        type="primary"
        @click="saveSettings"
      >
        <Check :size="16" />
        保存设置
      </NButton>
    </div>
    <section class="panel settings-panel">
      <div class="section-title">服务网络</div>
      <div class="form-grid">
        <div>
          <label for="port">监听端口</label>
          <NInputNumber
            :min="1024"
            :max="65535"
            :value="settings.port ?? null"
            :input-props="{ id: 'port', required: true }"
            @update:value="
              (value) => {
                settingsDirty = true
                if (settings) settings.port = value ?? 0
              }
            "
          />
        </div>
        <div>
          <label for="host">访问范围</label>
          <NSelect
            id="host"
            v-model:value="settings.host"
            :options="[
              { label: '仅本机 · 127.0.0.1', value: '127.0.0.1' },
              { label: '局域网 · 0.0.0.0', value: '0.0.0.0' },
            ]"
            aria-label="访问范围"
            @update:value="settingsDirty = true"
          />
        </div>
        <div>
          <label for="cache">客户端缓存（秒）</label>
          <NInputNumber
            :min="0"
            :max="86400"
            :value="settings.cacheSeconds ?? null"
            :input-props="{ id: 'cache', required: true }"
            @update:value="
              (value) => {
                settingsDirty = true
                if (settings) settings.cacheSeconds = value ?? 0
              }
            "
          />
          <small class="field-help">
            原地修改资源时建议设为 0；客户端已有缓存不会被目录监测清除。
          </small>
        </div>
      </div>
      <div class="network-addresses">
        <span>访问地址</span>
        <code
          v-for="address in snapshot?.server.addresses"
          :key="address"
        >
          {{ address }}
        </code>
      </div>
      <p class="field-help">
        修改监听地址或端口前请停止服务。关闭窗口只停止管理页面服务；GIS
        发布与任务在后台继续运行。发布服务需在此明确停止。
      </p>
    </section>
    <section class="panel settings-panel">
      <div class="section-title">任务并发</div>
      <div class="form-grid">
        <div>
          <label for="task-concurrency">同时运行任务数</label>
          <NInputNumber
            :min="1"
            :max="4"
            :value="settings.taskConcurrency ?? null"
            :input-props="{ id: 'task-concurrency', required: true }"
            @update:value="
              (value) => {
                settingsDirty = true
                if (settings) settings.taskConcurrency = value ?? 0
              }
            "
          />
        </div>
        <div>
          <label for="worker-budget">总并行预算</label>
          <NInputNumber
            :min="1"
            :max="16"
            :value="settings.workerBudget ?? null"
            :input-props="{ id: 'worker-budget', required: true }"
            @update:value="
              (value) => {
                settingsDirty = true
                if (settings) settings.workerBudget = value ?? 0
              }
            "
          />
        </div>
      </div>
      <p class="field-help">
        默认同时运行 2 个任务，总并行预算
        4。每个任务使用空余预算内的并行数；预算用完后排队。降低设置不会打断正在运行的任务。
      </p>
    </section>
    <section class="panel settings-panel">
      <div class="section-title">
        处理与发布引擎
        <span>路径留空时自动查找</span>
      </div>
      <div
        v-for="engine in snapshot?.engines"
        :key="engine.id"
        class="engine-row"
      >
        <div class="engine-label">
          <span
            class="dot"
            :class="{ online: engine.available }"
          ></span>
          <strong>{{ engine.label }}</strong>
          <small>{{ engine.available ? '已找到' : '未安装 / 未配置' }}</small>
        </div>
        <div class="path-input">
          <NInput
            :id="'engine-' + engine.id"
            v-model:value="settings[engine.id as 'nginx' | 'python' | 'gdal' | 'terrain' | 'osgb']"
            :aria-label="engine.label + ' 可执行文件路径'"
            :placeholder="engine.path || '选择可执行文件，或填写命令名称'"
          />
          <NButton
            class="ghost"
            attr-type="button"
            @click="
              action(() =>
                selectEngine(engine.id as 'nginx' | 'python' | 'gdal' | 'terrain' | 'osgb'),
              )
            "
          >
            <FolderOpen :size="15" />
            选择
          </NButton>
        </div>
      </div>
      <p class="field-help">
        地形需要支持 Mesh 的 CTB 分支，或已下载的 Docker CTB 镜像（路径填写 docker://ctb）；OSGB
        需要 fanvanzh/3dtiles 兼容引擎。引擎存在不代表所有数据都兼容。
      </p>
    </section>
    <section class="panel settings-panel">
      <div class="section-title">
        资源访问日志
        <span>最近 80 条</span>
      </div>
      <pre class="log-output">{{
        snapshot?.logs.join('\n') || '暂无访问记录。启动服务并访问资源后显示日志。'
      }}</pre>
    </section>
  </template>
</template>
