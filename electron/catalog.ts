import { opendir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Publication, Resource, ServiceKind } from '../shared/contracts'

const extensions: Record<ServiceKind, Set<string>> = {
  image: new Set(['.png','.jpg','.jpeg','.webp','.svg','.gif','.avif']),
  model: new Set(['.glb','.gltf']), imagery: new Set(['.png','.jpg','.jpeg','.webp']),
  terrain: new Set(['.terrain']), tileset: new Set(['.b3dm','.i3dm','.pnts','.cmpt','.glb','.gltf'])
}
export function normalizeMount(value: string): string {
  const result = `/${value.replace(/^\/+|\/+$/g,'')}/`
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)+$/.test(result) || result.startsWith('/_gis')) throw new Error('URL 前缀只允许英文、数字、下划线和短横线，例如 /terrain/china/')
  return result
}
export async function* walk(directory: string, root = directory): AsyncGenerator<Resource> {
  const entries = await opendir(directory)
  for await (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue
    const full = path.join(directory,entry.name)
    if (entry.isDirectory()) yield* walk(full,root)
    else if (entry.isFile()) {
      const info = await stat(full)
      yield {path: path.relative(root,full).split(path.sep).join('/'),size:info.size,modified:info.mtime.toISOString()}
    }
  }
}
export interface DirectoryScan { valid: boolean; reason: string; count: number; indexed: Resource[]; indexedAt: string; compressed?: boolean; bounds?: number[]; minZoom?: number; maxZoom?: number }
async function jsonFile(filename: string): Promise<Record<string, any>> {
  const info=await stat(filename); if(info.size>32*1024*1024) throw new Error('入口 JSON 超过 32 MB，请检查数据')
  return JSON.parse(await readFile(filename,'utf8'))
}
export async function scanDirectory(directory: string, kind: ServiceKind): Promise<DirectoryScan> {
  const result: DirectoryScan={valid:false,reason:'',count:0,indexed:[],indexedAt:new Date().toISOString()}
  try {
    const root=await realpath(directory); if(!(await stat(root)).isDirectory()) throw new Error('请选择目录')
    let first: Resource | undefined
    let firstCompressed: boolean | undefined
    const zooms=new Set<number>()
    for await (const resource of walk(root)) {
      const ext=path.extname(resource.path).toLowerCase()
      if(!extensions[kind].has(ext)) continue
      if(kind==='imagery' && !/^\d+\/\d+\/\d+\.(png|jpe?g|webp)$/i.test(resource.path)) continue
      if(kind==='terrain' && !/^\d+\/\d+\/\d+\.terrain$/i.test(resource.path)) continue
      if(!resource.size) continue
      first ??= resource; result.count++
      if(result.indexed.length<200) result.indexed.push(resource)
      if(kind==='imagery' || kind==='terrain') zooms.add(Number(resource.path.split('/')[0]))
      // Check a bounded sample; serving headers must match tile encoding.
      if(kind==='terrain' && result.count<=20) {
        const buffer=await readFile(path.join(root,resource.path))
        const compressed=buffer[0]===0x1f && buffer[1]===0x8b
        if(firstCompressed!==undefined && compressed!==firstCompressed) throw new Error('地形瓦片混合了 gzip 与未压缩编码，请统一后发布')
        firstCompressed=compressed
        if((compressed?gunzipSync(buffer):buffer).length<92) throw new Error('地形瓦片内容不完整')
      }
    }
    if(!first) throw new Error('目录内没有可发布资源（不索引隐藏文件及符号链接）')
    if(kind==='terrain') {
      const layer=await jsonFile(path.join(root,'layer.json'))
      if(layer.format!=='quantized-mesh-1.0' || !Array.isArray(layer.tiles) || !layer.tiles.length) throw new Error('layer.json 必须声明 quantized-mesh-1.0 和 tiles')
      if(!Array.isArray(layer.available) || !layer.available.length) throw new Error('地形缺少 available 瓦片范围；请重新生成 layer.json')
      result.compressed=firstCompressed
      if(Array.isArray(layer.bounds)) result.bounds=layer.bounds
    }
    if(kind==='tileset') {
      const seen=new Set<string>()
      async function checkManifest(file:string,depth=0):Promise<void> {
        if(depth>32) throw new Error('tileset 层级过深')
        if(seen.has(file)) return; seen.add(file)
        const manifest=await jsonFile(file)
        if(!manifest.asset?.version || !manifest.root?.boundingVolume) throw new Error('tileset.json 缺少 asset 或 root.boundingVolume')
        async function visit(tile:any):Promise<void> {
          for(const content of [...(tile.content?[tile.content]:[]),...(tile.contents??[])]) {
            const uri=content.uri??content.url
            if(typeof uri!=='string' || /^(https?:|data:|\/\/)/i.test(uri)) throw new Error('本地发布仅支持本目录内的 tileset 资源引用')
            const target=path.resolve(path.dirname(file),decodeURIComponent(uri.split(/[?#]/)[0]))
            const relative=path.relative(root,target)
            if(relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('tileset 引用了发布目录之外的文件')
            const actual=await realpath(target)
            if(actual!==target) throw new Error('tileset 不支持符号链接资源')
            const info=await stat(target); if(!info.isFile() || !info.size) throw new Error(`引用文件无效：${uri}`)
            if(path.extname(target)==='.json') await checkManifest(target,depth+1)
          }
          if(tile.implicitTiling) throw new Error('第一版仅支持显式 tileset 层级，请使用显式切片成果')
          for(const child of tile.children??[]) await visit(child)
        }
        await visit(manifest.root)
      }
      await checkManifest(path.join(root,'tileset.json'))
    }
    if(kind==='imagery') {
      result.minZoom=Math.min(...zooms);result.maxZoom=Math.max(...zooms)
      try {const metadata=await jsonFile(path.join(root,'gis-manifest.json')); if(Array.isArray(metadata.bounds))result.bounds=metadata.bounds}catch{}
    }
    result.valid=true; result.reason='资源目录有效'
  } catch(error) {result.reason=error instanceof Error?error.message:String(error)}
  return result
}
export function assertNoOverlap(publications: Publication[], mount: string, id?: string):void {
  if(publications.some(p=>p.id!==id && (p.mount.startsWith(mount)||mount.startsWith(p.mount)))) throw new Error('URL 前缀与已有服务重叠，请使用独立前缀')
}
