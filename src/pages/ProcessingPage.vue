<script setup lang="ts">
import { computed } from 'vue'
import { NForm } from 'naive-ui'
import { NRadio, NInput, NButton, NSelect, NInputNumber } from 'naive-ui'
import {
  Layers3,
  Settings2,
  FolderOpen,
  Search,
  Play,
  CircleAlert,
  Image,
  Mountain,
  ArrowUpRight,
  FileInput,
  X,
} from 'lucide-vue-next'
import { useWorkspaceContext } from '../app/useWorkspace'

import ZoomParameters from '../features/processing/components/ZoomParameters.vue'

const {
  tab,
  busy,
  inspection,
  inspecting,
  request,
  taskEngine,
  taskReady,
  packageImagery,
  jobNames,
  bytes,
  action,
  choose,
  inspect,
  submit,
  openAdvancedParameters,
  selectProcessingKind,
} = useWorkspaceContext()
const inputFiles = computed(() => [
  ...new Set([request.value.input, ...(request.value.inputs ?? [])].filter(Boolean)),
])
function changePrimaryInput(value: string) {
  request.value.input = value
  request.value.inputs = [request.value.input, ...(request.value.inputs ?? []).slice(1)]
  inspection.value = undefined
}
function moveInput(index: number, direction: number) {
  const paths = [...inputFiles.value]
  const target = index + direction
  if (target < 0 || target >= paths.length) {
    return
  }
  ;[paths[index], paths[target]] = [paths[target], paths[index]]
  request.value.input = paths[0]
  request.value.inputs = paths
  inspection.value = undefined
}
function removeInput(index: number) {
  const paths = inputFiles.value.filter((_, position) => position !== index)
  request.value.input = paths[0] ?? ''
  request.value.inputs = paths
  inspection.value = undefined
}
const outputLabel = computed(() =>
  request.value.kind === 'osgb'
    ? '3D Tiles 目录'
    : request.value.outputFormat === 'directory'
      ? '瓦片目录'
      : request.value.kind === 'imagery'
        ? 'MBTiles 单文件'
        : '地形 SQLite 单文件',
)
function setOffset(path: string, value: number | null) {
  request.value.heightOffsets = { ...request.value.heightOffsets, [path]: value ?? 0 }
}
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>数据处理</h1>
      <p>多个 TIFF 先融合，再切片打包；保留 COG 母数据供后续加工。</p>
    </div>
  </div>
  <div class="processing-layout">
    <NForm
      class="panel processing-form"
      @submit.prevent="submit"
    >
      <div class="processing-fields">
        <section
          class="processing-section"
          aria-labelledby="source-section-title"
        >
          <div class="processing-section-heading">
            <span>01</span>
            <h2 id="source-section-title">选择数据</h2>
            <small>
              {{ inputFiles.length ? inputFiles.length + ' 个输入' : '支持多文件融合' }}
            </small>
          </div>
          <fieldset class="kind-picker">
            <legend>处理类型</legend>
            <label
              v-for="kind in ['imagery', 'terrain', 'osgb'] as const"
              :key="kind"
              :class="{ chosen: request.kind === kind }"
            >
              <NRadio
                :aria-label="jobNames[kind]"
                :checked="request.kind === kind"
                @update:checked="selectProcessingKind(kind)"
              />
              <Image
                v-if="kind === 'imagery'"
                :size="20"
              />
              <Mountain
                v-else-if="kind === 'terrain'"
                :size="20"
              />
              <Layers3
                v-else
                :size="20"
              />
              <strong>{{ kind === 'osgb' ? '三维模型' : jobNames[kind] }}</strong>
            </label>
          </fieldset>
          <label for="input-path">
            {{ request.kind === 'osgb' ? '输入 OSGB 完整目录' : '输入 TIFF / VRT 文件' }}
          </label>
          <div
            v-if="request.kind !== 'osgb'"
            class="input-selection"
          >
            <FolderOpen :size="18" />
            <span :title="inputFiles.join('\n')">
              {{
                inputFiles.length ? `已选择 ${inputFiles.length} 个文件` : '选择 TIFF / VRT，可多选'
              }}
            </span>
            <NButton
              attr-type="button"
              @click="action(() => choose('input'))"
            >
              {{ inputFiles.length ? '重新选择' : '选择文件' }}
            </NButton>
          </div>
          <div
            v-else
            class="path-input"
          >
            <NInput
              :value="request.input"
              placeholder="选择或输入本地绝对路径"
              :input-props="{ id: 'input-path', required: true }"
              @update:value="changePrimaryInput"
            />
            <NButton
              class="ghost"
              attr-type="button"
              @click="action(() => choose('input'))"
            >
              <FolderOpen :size="16" />
              选择
            </NButton>
          </div>
          <details
            v-if="inputFiles.length && request.kind !== 'osgb'"
            class="selected-inputs"
          >
            <summary>查看文件与融合设置（{{ inputFiles.length }}）</summary>
            <div
              v-if="inputFiles.length"
              class="fusion-sources"
            >
              <div
                v-for="(file, index) in inputFiles"
                :key="file"
                class="fusion-source"
              >
                <span class="source-file-details">
                  <strong :title="file">{{ file.split(/[\\/]/).pop() }}</strong>
                </span>
                <template v-if="request.fusionPolicy === 'order'">
                  <NButton
                    size="small"
                    :disabled="index === 0"
                    :aria-label="'上移 ' + file"
                    @click="moveInput(index, -1)"
                  >
                    上移
                  </NButton>
                  <NButton
                    size="small"
                    :disabled="index === inputFiles.length - 1"
                    :aria-label="'下移 ' + file"
                    @click="moveInput(index, 1)"
                  >
                    下移
                  </NButton>
                </template>
                <NInputNumber
                  v-if="request.kind === 'terrain'"
                  :value="request.heightOffsets?.[file] ?? 0"
                  :min="-10000"
                  :max="10000"
                  :aria-label="file + ' 高程校正米'"
                  @update:value="(value) => setOffset(file, value)"
                >
                  <template #suffix>米校正</template>
                </NInputNumber>
                <NButton
                  quaternary
                  size="small"
                  class="source-remove"
                  :aria-label="'移除输入 ' + file"
                  @click="removeInput(index)"
                >
                  <template #icon><X :size="16" /></template>
                </NButton>
              </div>
            </div>
          </details>
        </section>
        <section
          class="processing-section"
          aria-labelledby="parameters-section-title"
        >
          <div class="processing-section-heading">
            <span>02</span>
            <h2 id="parameters-section-title">
              {{ request.kind === 'osgb' ? '场景定位' : '融合与切片' }}
            </h2>
          </div>
          <template v-if="request.kind !== 'osgb'">
            <label for="fusion-policy">融合优先级</label>
            <NSelect
              id="fusion-policy"
              v-model:value="request.fusionPolicy"
              aria-label="融合优先级"
              :options="[
                { label: '较精细数据优先（按投影后的像元间距）', value: 'precision' },
                { label: '按列表顺序覆盖（后面的有效值优先）', value: 'order' },
              ]"
            />
            <small class="field-help">
              无效值不会覆盖有效值。像元间距不能代表测量精度；来源质量不同时请手动排序。
            </small>
          </template>
          <ZoomParameters
            v-if="request.kind !== 'osgb'"
            v-model:min-zoom="request.minZoom"
            v-model:max-zoom="request.maxZoom"
            :kind="request.kind"
            :inspection="inspection"
          >
            <NButton
              class="ghost advanced-trigger"
              attr-type="button"
              @click="openAdvancedParameters"
            >
              <Settings2 :size="15" />
              高级参数
            </NButton>
          </ZoomParameters>
          <p
            v-if="request.kind !== 'osgb'"
            class="parameter-summary"
          >
            {{ request.workers }} 个请求并行 · {{ request.sourceCrs || '自动读取坐标系' }}
            <span v-if="request.kind === 'imagery' && request.scale">· 百分位拉伸</span>
          </p>
          <div v-if="request.kind === 'terrain'">
            <label for="vertical-datum">DEM 高程基准</label>
            <NSelect
              id="vertical-datum"
              v-model:value="request.verticalDatum"
              :options="[
                { label: '尚未确认', value: 'unknown' },
                { label: '米制 WGS84 椭球高（默认）', value: 'ellipsoid' },
              ]"
              aria-label="DEM 高程基准"
            />
            <small class="field-help">仅支持米制 WGS84 椭球高；其他高程基准请先转换。</small>
          </div>
          <div
            v-if="request.kind === 'osgb'"
            class="form-grid"
          >
            <div>
              <label for="longitude">定位经度（可选）</label>
              <NInputNumber
                :min="-180"
                :max="180"
                placeholder="metadata.xml 缺失时填写"
                :value="request.longitude ?? null"
                :input-props="{ id: 'longitude', required: false }"
                @update:value="(value) => (request.longitude = value ?? undefined)"
              />
            </div>
            <div>
              <label for="latitude">定位纬度（可选）</label>
              <NInputNumber
                :min="-90"
                :max="90"
                placeholder="WGS84 纬度"
                :value="request.latitude ?? null"
                :input-props="{ id: 'latitude', required: false }"
                @update:value="(value) => (request.latitude = value ?? undefined)"
              />
            </div>
          </div>
        </section>
        <section
          class="processing-section"
          aria-labelledby="output-section-title"
        >
          <div class="processing-section-heading">
            <span>03</span>
            <h2 id="output-section-title">输出成果</h2>
            <small>{{ outputLabel }}</small>
          </div>
          <template v-if="request.kind !== 'osgb'">
            <label for="output-format">成果格式</label>
            <NSelect
              id="output-format"
              v-model:value="request.outputFormat"
              aria-label="成果格式"
              :options="[
                {
                  label:
                    request.kind === 'imagery'
                      ? '单文件 MBTiles（推荐）'
                      : '单文件 Quantized Mesh SQLite（推荐）',
                  value: 'package',
                },
                { label: '传统瓦片目录（单输入）', value: 'directory' },
              ]"
            />
          </template>

          <label for="output-path">
            {{ request.outputFormat === 'package' ? '成果文件路径' : '输出目录' }}
          </label>
          <NInput
            v-model:value="request.output"
            class="output-path-picker"
            :placeholder="
              request.outputFormat === 'package'
                ? request.kind === 'imagery'
                  ? '例如 /数据/影像.mbtiles'
                  : '例如 /数据/地形.terrain.sqlite'
                : '选择一个空目录'
            "
            :input-props="{
              id: 'output-path',
              'aria-describedby': 'output-help',
              required: true,
            }"
          >
            <template #suffix>
              <NButton
                quaternary
                attr-type="button"
                class="output-path-picker-button"
                :aria-label="
                  request.outputFormat === 'package' ? '选择成果文件路径' : '选择输出目录'
                "
                title="选择保存位置"
                @click="action(() => choose('output'))"
              >
                <template #icon><FolderOpen :size="18" /></template>
              </NButton>
            </template>
          </NInput>
          <small
            id="output-help"
            class="field-help"
          >
            {{
              request.outputFormat === 'package'
                ? '使用新文件名；COG 母数据和恢复记录保存在成果旁的 .sources 目录。'
                : '使用空目录，不能与已发布目录重叠。'
            }}
          </small>
        </section>
      </div>
      <div class="process-actions">
        <div
          class="engine-hint"
          :class="{ missing: !taskReady }"
        >
          <span
            class="dot"
            :class="{ online: taskReady }"
          ></span>
          <span>
            {{
              taskReady
                ? packageImagery
                  ? '内置 MBTiles 处理器已就绪'
                  : taskEngine?.label + ' 已就绪'
                : '转换引擎未就绪'
            }}
          </span>
          <NButton
            v-if="!taskReady"
            class="text-button"
            attr-type="button"
            @click="tab = 'settings'"
          >
            配置引擎
            <ArrowUpRight :size="14" />
          </NButton>
        </div>
        <NButton
          class="primary"
          :disabled="
            busy ||
            !taskReady ||
            (request.kind === 'terrain' && request.verticalDatum !== 'ellipsoid')
          "
          attr-type="submit"
          type="primary"
        >
          <Play :size="16" />
          提交加工任务
        </NButton>
        <small
          v-if="request.kind === 'terrain' && request.verticalDatum !== 'ellipsoid'"
          class="submission-help"
        >
          确认高程基准后才能提交地形任务。
        </small>
      </div>
    </NForm>
    <aside class="panel inspection-panel">
      <div class="processing-summary">
        <div class="section-title">任务概览</div>
        <dl>
          <dt>输入数据</dt>
          <dd>{{ inputFiles.length }} 个{{ request.kind === 'osgb' ? '目录' : '文件' }}</dd>
          <dt>融合策略</dt>
          <dd>
            {{
              request.kind === 'osgb'
                ? '场景转换'
                : request.fusionPolicy === 'order'
                  ? '按列表顺序覆盖'
                  : '较精细数据优先'
            }}
          </dd>
          <dt>输出格式</dt>
          <dd>{{ outputLabel }}</dd>
          <template v-if="request.kind !== 'osgb'">
            <dt>切片层级</dt>
            <dd>{{ request.minZoom }} – {{ request.maxZoom }} 级</dd>
          </template>
        </dl>
        <div
          class="summary-output"
          :title="request.output"
        >
          <FolderOpen :size="16" />
          <span>
            {{ request.output ? request.output.split(/[\\/]/).pop() : '尚未设置成果路径' }}
          </span>
        </div>
      </div>

      <div class="section-title">
        <FileInput :size="18" />
        输入元信息
      </div>
      <NButton
        class="ghost wide"
        :disabled="!request.input || inspecting"
        attr-type="button"
        @click="action(() => inspect())"
      >
        <Search :size="16" />
        {{ inspecting ? '正在读取…' : '读取数据元信息' }}
      </NButton>
      <small
        v-if="inputFiles.length > 1"
        class="field-help"
      >
        此处显示首个输入；全部数据会在加工时校验。
      </small>
      <div
        v-if="inspection"
        class="inspection-info"
      >
        <dl>
          <template
            v-for="(value, key) in {
              类型: inspection.type,
              文件大小: inspection.size ? bytes(inspection.size) : undefined,
              栅格尺寸: inspection.width ? inspection.width + ' × ' + inspection.height : undefined,
              波段: inspection.bands,
              坐标系: inspection.crs,
              数据类型: inspection.dtype,
              高程单位: inspection.bands === 1 ? inspection.units || '未声明' : undefined,
              无效值: inspection.nodata,
              OSGB文件: inspection.files,
            }"
            :key="key"
          >
            <dt v-if="value !== undefined">{{ key }}</dt>
            <dd v-if="value !== undefined">{{ value ?? '未设置' }}</dd>
          </template>
        </dl>
        <label v-if="inspection.bounds">范围</label>
        <code v-if="inspection.bounds">
          {{ inspection.bounds.map((n) => n.toFixed(5)).join(', ') }}
        </code>
        <p
          v-for="warning in inspection.warnings"
          :key="warning"
          class="inspection-warning"
        >
          <CircleAlert :size="15" />
          {{ warning }}
        </p>
      </div>
      <div
        v-else
        class="inspection-empty"
      >
        <p>选择输入文件后，可读取数据详情。</p>
      </div>
    </aside>
  </div>
</template>
