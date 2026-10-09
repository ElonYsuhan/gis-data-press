<script setup lang="ts">
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  zhCN,
  dateZhCN,
  type GlobalThemeOverrides,
} from 'naive-ui'
const themeOverrides: GlobalThemeOverrides = {
  common: {
    fontSize: '16px',
    fontSizeSmall: '16px',
    fontSizeMedium: '16px',
    fontSizeLarge: '16px',
    primaryColor: '#3268e7',
    primaryColorHover: '#477bea',
    primaryColorPressed: '#2556c6',
    borderRadius: '7px',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  },
}
</script>
<template>
  <NConfigProvider
    :locale="zhCN"
    :date-locale="dateZhCN"
    :theme-overrides="themeOverrides"
  >
    <NMessageProvider>
      <NDialogProvider><slot /></NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
