<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { NModal } from 'naive-ui'
import type { DialogHandle } from './dialog'

defineOptions({ inheritAttrs: false })
const emit = defineEmits<{ close: []; cancel: [event: Event] }>()
const visible = ref(false)
const body = ref<HTMLElement>()
function close() {
  visible.value = false
}
function updateVisibility(value: boolean) {
  if (!value) {
    const event = new Event('cancel', { cancelable: true })
    emit('cancel', event)
    if (event.defaultPrevented) {
      return
    }
  }
  visible.value = value
}
defineExpose<DialogHandle>({
  showModal() {
    visible.value = true
    void nextTick()
  },
  close,
  querySelector<T extends Element>(selector: string) {
    return body.value?.querySelector<T>(selector) ?? null
  },
})
</script>
<template>
  <NModal
    :show="visible"
    :mask-closable="false"
    @update:show="updateVisibility"
    @after-leave="emit('close')"
  >
    <div
      ref="body"
      v-bind="$attrs"
      role="dialog"
      aria-modal="true"
    >
      <slot />
    </div>
  </NModal>
</template>
