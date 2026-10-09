<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import type { Publication } from '../../../shared/contracts'
import type { Viewer, ImageryLayer } from 'cesium'
import { NButton, NCheckbox, NSlider } from 'naive-ui'
import { Layers3, LocateFixed, ChevronUp } from 'lucide-vue-next'
import 'cesium/Build/Cesium/Widgets/widgets.css'
const props = defineProps<{ publication: Publication; base: string }>()
const container = ref<HTMLDivElement>()
const message = ref('正在加载本地服务…')
const failed = ref(false)
let viewer: Viewer | undefined
const controlsOpen = ref(true)
const baseVisible = ref(true)
const resourceVisible = ref(true)
const selectedLayer = ref<'base' | 'resource'>('resource')
const layerTransparency = ref({ base: 0, resource: 0 })
const opacity = computed({
  get: () => layerTransparency.value[selectedLayer.value],
  set: (value: number) => {
    layerTransparency.value[selectedLayer.value] = value
  },
})
const selectedLayerName = computed(() =>
  selectedLayer.value === 'base' ? 'OpenStreetMap 底图' : props.publication.name,
)
const canAdjustOpacity = computed(
  () => ready.value && (selectedLayer.value === 'base' || props.publication.kind === 'imagery'),
)
const ready = ref(false)
let baseLayer: ImageryLayer | undefined
let resourceLayer: ImageryLayer | undefined
let setResourceVisibility: ((visible: boolean) => void) | undefined
let locateResource: (() => void) | undefined
watch(baseVisible, (visible) => {
  if (baseLayer) {
    baseLayer.show = visible
  }
  viewer?.scene.requestRender()
})
watch(resourceVisible, (visible) => {
  setResourceVisibility?.(visible)
  viewer?.scene.requestRender()
})
watch(
  layerTransparency,
  (value) => {
    if (baseLayer) {
      baseLayer.alpha = 1 - value.base / 100
    }
    if (resourceLayer) {
      resourceLayer.alpha = 1 - value.resource / 100
    }
    viewer?.scene.requestRender()
  },
  { deep: true },
)
let disposed = false
const url = props.base + props.publication.mount
const resource = props.publication.indexed[0]
const assetUrl = resource ? url + resource.path.split('/').map(encodeURIComponent).join('/') : ''
onMounted(async () => {
  if (['image', 'model'].includes(props.publication.kind) && props.publication.kind === 'image') {
    message.value = ''
    return
  }
  try {
    window.CESIUM_BASE_URL = new URL('cesium/', document.baseURI).href
    const C = await import('cesium')
    if (disposed) {
      return
    }
    const background = new C.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      maximumLevel: 19,
      credit: new C.Credit(
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        true,
      ),
    })
    viewer = new C.Viewer(container.value!, {
      baseLayer: new C.ImageryLayer(background),
      geocoder: false,
      selectionIndicator: false,
      infoBox: false,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      homeButton: false,
      fullscreenButton: false,
      requestRenderMode: true,
    })
    baseLayer = viewer.imageryLayers.get(0)
    viewer.scene.globe.baseColor = C.Color.fromCssColorString('#253948')
    const p = props.publication
    if (p.kind === 'tileset') {
      const tiles = await C.Cesium3DTileset.fromUrl(url + 'tileset.json')
      if (disposed) {
        tiles.destroy()
        return
      }
      viewer.scene.primitives.add(tiles)
      setResourceVisibility = (visible) => {
        tiles.show = visible
      }
      locateResource = () => {
        void viewer?.zoomTo(tiles)
      }
      await viewer.zoomTo(tiles)
    }
    if (p.kind === 'imagery') {
      const extension = p.indexed[0]?.path.split('.').pop() ?? 'png'
      const rectangle =
        p.bounds?.length === 4
          ? C.Rectangle.fromDegrees(...(p.bounds as [number, number, number, number]))
          : undefined
      resourceLayer = viewer.imageryLayers.addImageryProvider(
        new C.UrlTemplateImageryProvider({
          url: url + `{z}/{x}/{y}.${extension}`,
          minimumLevel: p.minZoom ?? 0,
          maximumLevel: p.maxZoom ?? 18,
          rectangle,
        }),
      )
      setResourceVisibility = (visible) => {
        if (resourceLayer) {
          resourceLayer.show = visible
        }
      }
      if (rectangle) {
        locateResource = () => viewer?.camera.flyTo({ destination: rectangle })
        viewer.camera.flyTo({ destination: rectangle })
      }
    }
    if (p.kind === 'terrain') {
      const terrain = await C.CesiumTerrainProvider.fromUrl(url)
      if (disposed) {
        return
      }
      viewer.terrainProvider = terrain
      const flat = new C.EllipsoidTerrainProvider()
      setResourceVisibility = (visible) => {
        if (viewer) {
          viewer.terrainProvider = visible ? terrain : flat
        }
      }
      if (p.bounds?.length === 4) {
        const destination = C.Rectangle.fromDegrees(
          ...(p.bounds as [number, number, number, number]),
        )
        locateResource = () => viewer?.camera.flyTo({ destination })
        viewer.camera.flyTo({
          destination: C.Rectangle.fromDegrees(...(p.bounds as [number, number, number, number])),
        })
      }
    }
    if (p.kind === 'model') {
      const entity = viewer.entities.add({
        position: C.Cartesian3.fromDegrees(0, 0),
        model: { uri: assetUrl, minimumPixelSize: 128 },
      })
      setResourceVisibility = (visible) => {
        entity.show = visible
      }
      locateResource = () => {
        void viewer?.zoomTo(entity)
      }
      await viewer.zoomTo(entity)
    }
    ready.value = true
    message.value = p.kind === 'model' ? '单体模型暂放置于经纬度 0°，仅用于外观预览。' : ''
    viewer.scene.renderError.addEventListener((_scene, error) => {
      failed.value = true
      message.value = String(error)
    })
  } catch (error) {
    failed.value = true
    message.value = '加载失败：' + String(error)
  }
})
onBeforeUnmount(() => {
  disposed = true
  viewer?.destroy()
})
function handleImageError() {
  failed.value = true
  message.value = '图片加载失败'
}
</script>
<template>
  <div class="preview-canvas">
    <div
      v-if="publication.kind !== 'image'"
      ref="container"
      class="cesium-host"
    ></div>
    <div
      v-else
      class="image-preview"
    >
      <img
        :src="assetUrl"
        :alt="resource?.path"
        @error="handleImageError"
      />
    </div>
    <div
      v-if="publication.kind !== 'image'"
      class="preview-layer-control"
    >
      <NButton
        class="layer-control-toggle"
        attr-type="button"
        :aria-expanded="controlsOpen"
        aria-controls="preview-layer-options"
        @click="controlsOpen = !controlsOpen"
      >
        <Layers3 :size="18" />
        图层控制
        <ChevronUp
          :size="16"
          :class="{ collapsed: !controlsOpen }"
        />
      </NButton>
      <div
        v-show="controlsOpen"
        id="preview-layer-options"
        class="layer-control-options"
      >
        <div
          class="layer-select-row"
          :class="{ selected: selectedLayer === 'base' }"
        >
          <NCheckbox
            v-model:checked="baseVisible"
            :disabled="!ready"
            aria-label="显示底图"
          />
          <NButton
            text
            attr-type="button"
            :aria-pressed="selectedLayer === 'base'"
            @click="selectedLayer = 'base'"
          >
            OpenStreetMap 底图
          </NButton>
        </div>
        <div
          class="layer-select-row"
          :class="{ selected: selectedLayer === 'resource' }"
        >
          <NCheckbox
            v-model:checked="resourceVisible"
            :disabled="!ready"
            aria-label="显示资源"
          />
          <NButton
            text
            attr-type="button"
            :aria-pressed="selectedLayer === 'resource'"
            @click="selectedLayer = 'resource'"
          >
            {{ publication.name }}
          </NButton>
        </div>
        <div class="layer-opacity">
          <label id="preview-opacity-label">
            透明度
            <span>{{ opacity }}%</span>
          </label>
          <small class="selected-layer-caption">{{ selectedLayerName }}</small>
          <NSlider
            v-model:value="opacity"
            :disabled="!canAdjustOpacity"
            :step="5"
            aria-labelledby="preview-opacity-label"
          />
          <small v-if="!canAdjustOpacity && ready">该图层不支持透明度调整</small>
        </div>
        <NButton
          quaternary
          attr-type="button"
          :disabled="!ready || !locateResource"
          @click="locateResource?.()"
        >
          <LocateFixed :size="16" />
          定位资源
        </NButton>
      </div>
    </div>
    <div
      v-if="message"
      class="preview-message"
      :class="{ failure: failed }"
      role="status"
    >
      {{ message }}
    </div>
  </div>
</template>
