<script setup lang="ts">
import { NForm } from 'naive-ui'
import { NButton, NInputNumber, NInput, NCheckbox, NSelect } from 'naive-ui'
import { RadioTower, FolderOpen, Trash2, Check, X } from 'lucide-vue-next'
import { useWorkspaceContext } from '../app/useWorkspace'

import AppDialog from '../components/AppDialog.vue'
import { defineAsyncComponent } from 'vue'
const Preview = defineAsyncComponent(() => import('../features/preview/Preview.vue'))
const {
  api,
  busy,
  error,
  removalDialog,
  pendingRemoval,
  removalError,
  advancedDialog,
  serviceDialog,
  previewDialog,
  previewPublication,
  dialogTitle,
  form,
  request,
  kindOptions,
  base,
  action,
  choose,
  closeDialog,
  saveService,
  finishRemoval,
  confirmRemoval,
} = useWorkspaceContext()
</script>
<template>
  <AppDialog
    ref="removalDialog"
    class="service-dialog removal-dialog"
    aria-labelledby="removal-title"
    aria-describedby="removal-description"
    @cancel="busy && $event.preventDefault()"
    @close="finishRemoval"
  >
    <div class="advanced-body">
      <div class="dialog-header">
        <h2 id="removal-title">确认移除服务映射？</h2>
        <NButton
          class="icon-button"
          aria-label="关闭移除确认"
          :disabled="busy"
          attr-type="button"
          @click="closeDialog(removalDialog)"
        >
          <X :size="20" />
        </NButton>
      </div>
      <div class="removal-summary">
        <strong>{{ pendingRemoval?.name }}</strong>
        <code>{{ pendingRemoval?.mount }}</code>
      </div>
      <p id="removal-description">
        移除后，该服务地址将不再提供资源。磁盘中的原始数据和加工成果会保留。
      </p>
      <div
        v-if="removalError"
        class="alert error"
        role="alert"
      >
        {{ removalError }}
      </div>
      <div class="dialog-footer">
        <NButton
          data-cancel
          class="ghost"
          :disabled="busy"
          attr-type="button"
          @click="closeDialog(removalDialog)"
        >
          取消
        </NButton>
        <NButton
          class="primary destructive"
          :disabled="busy"
          attr-type="button"
          type="error"
          @click="confirmRemoval"
        >
          <Trash2 :size="15" />
          {{ busy ? '正在移除…' : '确认移除' }}
        </NButton>
      </div>
    </div>
  </AppDialog>
  <AppDialog
    ref="advancedDialog"
    class="service-dialog advanced-dialog"
    aria-labelledby="advanced-title"
  >
    <div class="advanced-body">
      <div class="dialog-header">
        <div>
          <h2 id="advanced-title">高级参数</h2>
          <p>参数直接用于当前任务。</p>
        </div>
        <NButton
          class="icon-button"
          aria-label="关闭高级参数"
          attr-type="button"
          @click="closeDialog(advancedDialog)"
        >
          <X :size="20" />
        </NButton>
      </div>
      <div class="form-grid">
        <div>
          <label for="workers">单任务并行数</label>
          <NInputNumber
            :min="1"
            :max="8"
            :value="request.workers ?? null"
            :input-props="{ id: 'workers', required: true }"
            @update:value="(value) => (request.workers = value ?? 0)"
          />
        </div>
        <div>
          <label for="source-crs">源坐标系（可选）</label>
          <NInput
            v-model:value="request.sourceCrs"
            placeholder="例如 EPSG:4490"
            :input-props="{ id: 'source-crs' }"
          />
        </div>
      </div>
      <label
        v-if="request.kind === 'imagery'"
        class="checkbox"
      >
        <NCheckbox v-model:checked="request.scale" />
        按采样的 2%–98% 百分位拉伸至 RGB Byte
      </label>
      <div class="dialog-footer">
        <NButton
          class="primary"
          attr-type="button"
          type="primary"
          @click="closeDialog(advancedDialog)"
        >
          <Check :size="16" />
          完成
        </NButton>
      </div>
    </div>
  </AppDialog>
  <AppDialog
    ref="serviceDialog"
    class="service-dialog"
    aria-labelledby="service-dialog-title"
  >
    <NForm @submit.prevent="saveService">
      <div class="dialog-header">
        <div>
          <h2 id="service-dialog-title">{{ dialogTitle }}</h2>
          <p>将 URL 前缀映射到一个本地资源目录。</p>
        </div>
        <NButton
          class="icon-button"
          aria-label="关闭目录映射窗口"
          attr-type="button"
          @click="closeDialog(serviceDialog)"
        >
          <X :size="20" />
        </NButton>
      </div>
      <label for="service-name">服务名称</label>
      <NInput
        v-model:value="form.name"
        placeholder="例如：中国 30 米地形"
        :input-props="{ id: 'service-name', maxlength: '80', required: true }"
      />
      <label for="service-kind">资源类型</label>
      <NSelect
        id="service-kind"
        v-model:value="form.kind"
        :options="kindOptions"
        aria-label="资源类型"
      />
      <label for="service-directory">本地资源目录 / 瓦片包</label>
      <div class="path-input">
        <NInput
          v-model:value="form.directory"
          placeholder="输入资源目录或 .mbtiles / .terrain.sqlite 文件路径"
          :input-props="{ id: 'service-directory', required: true }"
        />
        <NButton
          class="ghost"
          attr-type="button"
          @click="action(() => choose('directory'))"
        >
          <FolderOpen :size="16" />
          选择
        </NButton>
      </div>
      <NButton
        v-if="form.kind === 'imagery' || form.kind === 'terrain'"
        text
        @click="
          action(async () => {
            const file = await api.choose('file')
            if (file) {
              form.directory = file
            }
          })
        "
      >
        选择单文件瓦片包
      </NButton>
      <label for="service-mount">URL 前缀</label>
      <NInput
        v-model:value="form.mount"
        placeholder="例如 /terrain/china/"
        :input-props="{ id: 'service-mount', required: true, 'aria-describedby': 'mount-help' }"
      />
      <small
        id="mount-help"
        class="field-help"
      >
        只允许英文、数字、下划线、短横线和分层斜线。
      </small>
      <div
        v-if="error"
        class="alert error"
        role="alert"
      >
        {{ error }}
      </div>
      <div class="dialog-footer">
        <NButton
          class="ghost"
          attr-type="button"
          @click="closeDialog(serviceDialog)"
        >
          取消
        </NButton>
        <NButton
          class="primary"
          :disabled="busy"
          attr-type="submit"
          type="primary"
        >
          <RadioTower :size="16" />
          保存目录映射
        </NButton>
      </div>
    </NForm>
  </AppDialog>
  <AppDialog
    ref="previewDialog"
    class="preview-dialog"
    aria-labelledby="preview-dialog-title"
    @close="previewPublication = undefined"
  >
    <div class="dialog-header">
      <div>
        <h2 id="preview-dialog-title">{{ previewPublication?.name }}</h2>
        <p>直接加载当前 Nginx 服务中的资源</p>
      </div>
      <NButton
        class="icon-button"
        aria-label="关闭资源预览"
        attr-type="button"
        @click="closeDialog(previewDialog)"
      >
        <X :size="20" />
      </NButton>
    </div>
    <Preview
      v-if="previewPublication"
      :key="previewPublication.id"
      :publication="previewPublication"
      :base="base"
    />
  </AppDialog>
</template>
