<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Publication } from '../../../shared/contracts'
import type { Viewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
const props = defineProps<{ publication: Publication; base: string }>()
const container = ref<HTMLDivElement>()
const message = ref('正在加载本地服务…')
const failed = ref(false)
let viewer: Viewer | undefined
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
    viewer.scene.globe.baseColor = C.Color.fromCssColorString('#253948')
    const p = props.publication
    if (p.kind === 'tileset') {
      const tiles = await C.Cesium3DTileset.fromUrl(url + 'tileset.json')
      if (disposed) {
        tiles.destroy()
        return
      }
      viewer.scene.primitives.add(tiles)
      await viewer.zoomTo(tiles)
    }
    if (p.kind === 'imagery') {
      const extension = p.indexed[0]?.path.split('.').pop() ?? 'png'
      const rectangle =
        p.bounds?.length === 4
          ? C.Rectangle.fromDegrees(...(p.bounds as [number, number, number, number]))
          : undefined
      viewer.imageryLayers.addImageryProvider(
        new C.UrlTemplateImageryProvider({
          url: url + `{z}/{x}/{y}.${extension}`,
          minimumLevel: p.minZoom ?? 0,
          maximumLevel: p.maxZoom ?? 18,
          rectangle,
        }),
      )
      if (rectangle) {
        viewer.camera.flyTo({ destination: rectangle })
      }
    }
    if (p.kind === 'terrain') {
      const terrain = await C.CesiumTerrainProvider.fromUrl(url)
      if (disposed) {
        return
      }
      viewer.terrainProvider = terrain
      if (p.bounds?.length === 4) {
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
      await viewer.zoomTo(entity)
    }
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
      v-if="message"
      class="preview-message"
      :class="{ failure: failed }"
      role="status"
    >
      {{ message }}
    </div>
  </div>
</template>
