import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { createServer } from 'vite'
import { cp, mkdir } from 'node:fs/promises'
import electron from 'electron'
await mkdir('public/cesium', { recursive: true })
for (const dir of ['Assets', 'Workers', 'Widgets', 'ThirdParty']) {
  await cp(`node_modules/cesium/Build/Cesium/${dir}`, `public/cesium/${dir}`, { recursive: true })
}
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
const server = await createServer()
await server.listen()
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, GIS_DEV_URL: 'http://127.0.0.1:5173' },
})
child.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill())
}
