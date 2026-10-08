<script setup lang="ts">
import { NRadio, NInputNumber, NSelect } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import type { Inspection } from '../../../../shared/contracts'
import { metresAtZoom, zoomForMetres, type TiledKind } from '../domain/zoom'
const props = defineProps<{ kind: TiledKind; inspection?: Inspection }>()
const minZoom = defineModel<number>('minZoom', { required: true })
const maxZoom = defineModel<number>('maxZoom', { required: true })
const mode = ref<'resolution' | 'manual'>('manual')
const resolution = ref<number | null>(null)
const unit = ref<'m' | 'cm' | 'km'>('m')
const latitude = ref(0)
const metres = computed(
  () => Number(resolution.value) * (unit.value === 'cm' ? 0.01 : unit.value === 'km' ? 1000 : 1),
)
const recommendation = computed(() => {
  try {
    return zoomForMetres(props.kind, metres.value, latitude.value)
  } catch {
    return undefined
  }
})
const effectiveMetres = computed(() => {
  try {
    return metresAtZoom(props.kind, maxZoom.value, latitude.value)
  } catch {
    return undefined
  }
})
function useSource() {
  const data = props.inspection
  if (!data) {
    return
  }
  const centre =
    data.centerLatitude ?? (data.crs && data.bounds ? (data.bounds[1] + data.bounds[3]) / 2 : 0)
  latitude.value = Math.max(-85, Math.min(85, centre))
  let value = data.resolutionMeters
  if (!value && data.pixelSize) {
    const pixel = Math.max(...data.pixelSize.map(Math.abs))
    if (data.crs === 'EPSG:3857') {
      value = pixel * Math.cos((latitude.value * Math.PI) / 180)
    } else if (data.crs === 'EPSG:4326') {
      value = pixel * 111319.49079327358
    }
  }
  if (value && Number.isFinite(value) && value > 0) {
    resolution.value = Number(value.toPrecision(6))
    unit.value = 'm'
  }
}
watch(() => props.inspection, useSource, { immediate: true })
watch(
  [mode, recommendation, () => props.kind],
  () => {
    if (props.kind === 'terrain') {
      minZoom.value = 0
    }
    if (mode.value === 'resolution' && recommendation.value !== undefined) {
      maxZoom.value = Math.min(22, recommendation.value)
      if (minZoom.value > maxZoom.value) {
        minZoom.value = maxZoom.value
      }
    }
  },
  { immediate: true },
)
const format = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
</script>
<template>
  <section
    class="zoom-options"
    aria-label="分辨率与切片层级"
  >
    <fieldset class="zoom-mode">
      <legend>层级设置方式</legend>
      <label>
        <NRadio
          :checked="mode === 'resolution'"
          @update:checked="mode = 'resolution'"
        />
        按分辨率自动换算
      </label>
      <label>
        <NRadio
          :checked="mode === 'manual'"
          @update:checked="mode = 'manual'"
        />
        手动填写层级
      </label>
    </fieldset>
    <div
      v-if="mode === 'resolution'"
      class="resolution-fields"
    >
      <div>
        <label for="source-resolution">源数据水平分辨率</label>
        <div class="resolution-value">
          <NInputNumber
            :min="0.000001"
            placeholder="例如 30 或 5"
            :value="resolution ?? null"
            :input-props="{ id: 'source-resolution', required: true }"
            @update:value="(value) => (resolution = value ?? null)"
          />
          <NSelect
            v-model:value="unit"
            aria-label="分辨率单位"
            :options="[
              { label: '米', value: 'm' },
              { label: '厘米', value: 'cm' },
              { label: '千米', value: 'km' },
            ]"
          />
        </div>
      </div>
      <div v-if="kind === 'imagery'">
        <label for="reference-latitude">参考纬度（°）</label>
        <NInputNumber
          :min="-85"
          :max="85"
          :value="latitude ?? null"
          :input-props="{ id: 'reference-latitude', required: true }"
          @update:value="(value) => (latitude = value ?? 0)"
        />
      </div>
    </div>
    <p
      v-if="mode === 'resolution'"
      class="field-help"
    >
      选择文件后自动读取水平格网间距，也可自行填写；这里不是高程的垂直精度。{{
        kind === 'imagery'
          ? '参考纬度默认使用数据中心，未知时为 0°。'
          : '地形层级按当前切片引擎的采样间距估算，作为加工建议。'
      }}
    </p>
    <div class="process-parameters">
      <div>
        <label for="min-zoom">最小层级</label>
        <NInputNumber
          :min="0"
          :max="maxZoom"
          :readonly="kind === 'terrain'"
          :value="minZoom ?? null"
          :input-props="{ id: 'min-zoom', required: true }"
          @update:value="(value) => (minZoom = value ?? 0)"
        />
      </div>
      <div>
        <label for="max-zoom">最大层级</label>
        <NInputNumber
          :min="minZoom"
          :max="22"
          :readonly="mode === 'resolution'"
          :value="maxZoom ?? null"
          :input-props="{ id: 'max-zoom', required: true }"
          @update:value="(value) => (maxZoom = value ?? 0)"
        />
      </div>
      <slot />
    </div>
    <p
      class="zoom-result"
      role="status"
    >
      {{ maxZoom }} 级{{
        effectiveMetres !== undefined
          ? '约 ' + format(effectiveMetres) + (kind === 'imagery' ? ' 米/像素' : ' 米/采样间距')
          : ''
      }}
      <span v-if="mode === 'resolution' && recommendation !== undefined">
        · 按源分辨率推荐 {{ recommendation }} 级{{
          recommendation > 22 ? '，已限制为平台支持的 22 级' : ''
        }}
      </span>
    </p>
    <p
      v-if="mode === 'manual' && recommendation !== undefined && maxZoom > recommendation"
      class="field-help"
    >
      当前层级高于源分辨率建议值；增加层级会增加瓦片量，不会补充原始数据细节。
    </p>
  </section>
</template>
