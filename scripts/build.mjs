import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'
await build({
  entryPoints: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
    service: 'server/index.ts',
  },
  outdir: 'dist-electron',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: true,
})
await mkdir('dist/cesium', { recursive: true })
for (const dir of ['Assets', 'Workers', 'Widgets', 'ThirdParty']) {
  await cp(`node_modules/cesium/Build/Cesium/${dir}`, `dist/cesium/${dir}`, { recursive: true })
}

await cp('resources/icons/icon-512.png', 'dist/app-icon.png')
