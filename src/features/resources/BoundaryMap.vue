<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { Viewer, GeoJsonDataSource, ScreenSpaceEventHandler } from 'cesium'
import type { BoundaryResult } from '../../../shared/contracts'
import { api } from '../../services/api'
import 'cesium/Build/Cesium/Widgets/widgets.css'

const props = defineProps<{ selected?: BoundaryResult }>()
const emit = defineEmits<{ select: [result: BoundaryResult] }>()
const container = ref<HTMLDivElement>()
const loading = ref(true)
const error = ref('')
const scope = ref<BoundaryResult>({ adcode: 100000, name: '全国', level: 'country', ancestors: '' })
const layers = new Map<number, GeoJsonDataSource>()
const regions = new Map<number, BoundaryResult>()
let clickRevision = 0
const hover = ref<{ name: string; code: number; x: number; y: number }>()
let viewer: Viewer | undefined
let layer: GeoJsonDataSource | undefined
let handler: ScreenSpaceEventHandler | undefined
let disposed = false
let revision = 0
let controller: AbortController | undefined
let C: typeof import('cesium')
async function parentRegion(region: BoundaryResult): Promise<BoundaryResult | undefined> {
  if (region.level === 'country') {return undefined}
  if (region.level === 'province')
    {return {
      adcode: 100000,
      name: '全国',
      level: 'country',
      ancestors: '',
    }}
  const name = region.ancestors.split(' / ').at(-1)
  if (!name) {return undefined}
  const results = await api.searchBoundaries(name)
  return results.find((result) => result.name === name && result.adcode !== region.adcode)
}

async function load(region: BoundaryResult, locate = true) {
  if (!viewer) {
    return
  }
  const version = ++revision
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    let next = layers.get(region.adcode)
    if (!next) {
      const suffix = region.level === 'district' ? '' : '_full'
      const response = await fetch(
        `https://geo.datav.aliyun.com/areas_v3/bound/${region.adcode}${suffix}.json`,
        { signal: controller.signal },
      )
      if (!response.ok) {throw new Error('边界数据暂时不可用')}
      next = await C.GeoJsonDataSource.load(await response.json(), {
        fill: C.Color.fromCssColorString('#4181ef').withAlpha(0.08),
        stroke: C.Color.fromCssColorString('#567595'),
        strokeWidth: 2,
      })
      if (disposed || version !== revision) {return}
      await viewer.dataSources.add(next)
      layers.set(region.adcode, next)
    }
    if (disposed || version !== revision) {return}
    if (layer) {layer.show = false}
    layer = next
    next.show = true
    regions.set(region.adcode, region)
    scope.value = region
    if (locate) {
      await viewer.flyTo(next, { duration: 0.65 })
    }
    highlight()
    viewer.scene.requestRender()
  } catch (e) {
    if (!disposed && version === revision) {
      error.value = String(e).replace(/^Error: /, '')
    }
  } finally {
    if (!disposed && version === revision) {
      loading.value = false
    }
  }
}
function highlight() {
  if (!layer) {
    return
  }
  for (const entity of layer.entities.values) {
    if (!entity.polygon) {
      continue
    }
    const code = Number(entity.properties?.adcode?.getValue(C.JulianDate.now()))
    entity.polygon.material = new C.ColorMaterialProperty(
      C.Color.fromCssColorString('#4181ef').withAlpha(
        code === props.selected?.adcode ? 0.25 : 0.08,
      ),
    )
  }
  viewer?.scene.requestRender()
}
watch(
  () => props.selected,
  async (value) => {
    highlight()
    if (value && viewer && value.adcode !== scope.value.adcode) {
      await load(value)
      highlight()
    }
  },
)
onMounted(async () => {
  try {
    window.CESIUM_BASE_URL = new URL('cesium/', document.baseURI).href
    C = await import('cesium')
    if (disposed) {
      return
    }
    viewer = new C.Viewer(container.value!, {
      baseLayer: new C.ImageryLayer(
        new C.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
      ),
      sceneMode: C.SceneMode.SCENE2D,
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      baseLayerPicker: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: true,
    })
    handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction(async (event: { position: import('cesium').Cartesian2 }) => {
      if (loading.value || !viewer) {return}
      const click = ++clickRevision
      hover.value = undefined
      const picked = viewer.scene.pick(event.position)
      try {
        let result: BoundaryResult | undefined
        if (picked?.id instanceof C.Entity) {
          const code = Number(picked.id.properties?.adcode?.getValue(C.JulianDate.now()))
          if (!Number.isInteger(code) || code === scope.value.adcode) {return}
          result = regions.get(code) ?? (await api.searchBoundaries(String(code)))[0]
        } else if (viewer.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid)) {
          result = await parentRegion(scope.value)
        }
        if (!disposed && click === clickRevision && result) {
          regions.set(result.adcode, result)
          emit('select', result)
        }
      } catch {
        error.value = '选区失败，请重试或使用搜索'
      }
    }, C.ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction((event: { endPosition: import('cesium').Cartesian2 }) => {
      const picked = viewer?.scene.pick(event.endPosition)
      if (!(picked?.id instanceof C.Entity)) {
        hover.value = undefined
        return
      }
      const properties = picked.id.properties
      const code = Number(properties?.adcode?.getValue(C.JulianDate.now()))
      const name = String(properties?.name?.getValue(C.JulianDate.now()) ?? '')
      hover.value = Number.isInteger(code)
        ? {
            name,
            code,
            x: event.endPosition.x + 12,
            y: event.endPosition.y + 12,
          }
        : undefined
    }, C.ScreenSpaceEventType.MOUSE_MOVE)
    await load(props.selected ?? scope.value)
    highlight()
  } catch (e) {
    error.value = String(e)
    loading.value = false
  }
})
onBeforeUnmount(() => {
  disposed = true
  revision++
  controller?.abort()
  layers.clear()
  regions.clear()
  handler?.destroy()
  viewer?.destroy()
})
</script>
<template>
  <div class="boundary-map">
    <div
      ref="container"
      class="boundary-map-canvas"
      aria-label="行政区边界选择地图"
    />
    <div class="boundary-map-toolbar">
      <span>{{ scope.name }}</span>
    </div>
    <div
      v-if="hover"
      class="boundary-map-hover"
      :style="{ left: hover.x + 'px', top: hover.y + 'px' }"
    >
      <strong>{{ hover.name }}</strong>
      <small>{{ hover.code }}</small>
    </div>
    <div
      class="boundary-map-caption"
      role="status"
    >
      {{
        error ||
        (loading
          ? '正在加载边界…'
          : selected
            ? `${selected.name} · ${selected.adcode}`
            : '点击地图选择行政区')
      }}
      <NButton
        v-if="error"
        size="small"
        @click="load(scope)"
      >
        重试
      </NButton>
    </div>
  </div>
</template>
