import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'
await build({entryPoints:['electron/main.ts','electron/preload.ts','electron/service.ts'],outdir:'dist-electron',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},external:['electron'],sourcemap:true})
await mkdir('dist/cesium',{recursive:true})
for(const dir of ['Assets','Workers','Widgets','ThirdParty']) await cp(`node_modules/cesium/Build/Cesium/${dir}`,`dist/cesium/${dir}`,{recursive:true})

await cp('resources/icons/icon-512.png','dist/app-icon.png')
