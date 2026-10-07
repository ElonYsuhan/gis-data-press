<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Download, Search, FolderOpen, Plus, X, RefreshCw } from 'lucide-vue-next'
import { api as managementAPI } from './api'
const api=managementAPI
import type { AssetKind, LocalAsset, BoundaryResult } from '../shared/contracts'
const emit=defineEmits<{process:[kind:'imagery'|'terrain',path:string];publish:[kind:AssetKind,path:string]}>()
const types:{kind:AssetKind;name:string}[]=[{kind:'imagery',name:'影像数据'},{kind:'terrain',name:'地形数据'},{kind:'boundary',name:'区域边界'},{kind:'tileset',name:'3D Tiles'},{kind:'image',name:'图片'},{kind:'model',name:'glTF'}]
const kind=ref<AssetKind>('boundary');const query=ref('');const matches=ref<BoundaryResult[]>([]);const selected=ref<BoundaryResult>();const children=ref(false);const directory=ref('');const url=ref('');const filename=ref('');const localPath=ref('');const records=ref<LocalAsset[]>([]);const busy=ref(false);const searching=ref(false);const searched=ref(false);const error=ref('');const notice=ref('');const page=ref(1);const pending=ref<LocalAsset>();const confirmation=ref<HTMLDialogElement>()
const levelNames:Record<string,string>={country:'国家',province:'省级',city:'市级',district:'区县'}
const filtered=computed(()=>records.value.filter(r=>r.kind===kind.value));const pages=computed(()=>Math.max(1,Math.ceil(filtered.value.length/3)));const visible=computed(()=>filtered.value.slice((Math.min(page.value,pages.value)-1)*3,Math.min(page.value,pages.value)*3));const resultPage=ref(1);const visibleMatches=computed(()=>matches.value.slice((resultPage.value-1)*4,resultPage.value*4));
let interval:ReturnType<typeof setInterval>;let polling=false
async function refresh(){if(polling)return;polling=true;try{records.value=await api.resources()}catch(e){error.value=String(e)}finally{polling=false}}
async function action(fn:()=>Promise<unknown>,message=''){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await fn();await refresh();notice.value=message}catch(e){error.value=String(e).replace(/^.*?Error: (?:Error: )*/, '').replace(/^Error invoking remote method '[^']+': /, '')}finally{busy.value=false}}
async function search(){if(searching.value)return;searching.value=true;error.value='';selected.value=undefined;matches.value=[];searched.value=false;try{matches.value=await api.searchBoundaries(query.value);searched.value=true;resultPage.value=1}catch(e){error.value=String(e)}finally{searching.value=false}}
async function chooseDirectory(){await action(async()=>{const p=await api.choose('directory');if(p)directory.value=p})}
async function chooseLocal(mode:'file'|'directory'){await action(async()=>{const p=await api.choose(mode);if(p)localPath.value=p})}
async function download(){await action(async()=>{if(kind.value==='boundary'&&!selected.value)throw new Error('请先选择检索结果');await api.downloadResource({kind:kind.value,directory:directory.value,url:url.value,filename:filename.value,adcode:selected.value?.adcode,children:children.value});page.value=1},'下载已开始，文件写入指定目录；关闭管理窗口后继续下载。')}
function selectType(value:AssetKind){kind.value=value;page.value=1;error.value='';notice.value=''}
function status(r:LocalAsset){return r.status==='ready'?(r.exists?'本地可用':'文件已失效'):r.status==='downloading'?'下载中':r.status==='cancelled'?'已取消':'下载失败'}
function size(n:number){return n>=1e6?(n/1e6).toFixed(1)+' MB':n>=1e3?(n/1e3).toFixed(1)+' KB':n+' B'}
async function askForget(r:LocalAsset){pending.value=r;confirmation.value?.showModal();confirmation.value?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus()}
async function forget(){if(!pending.value)return;await action(async()=>{await api.forgetResource(pending.value!.id);confirmation.value?.close();pending.value=undefined},'已移除资源索引，磁盘文件保留。')}
onMounted(()=>{void refresh();interval=setInterval(()=>void refresh(),1500)});onBeforeUnmount(()=>clearInterval(interval))
</script>
<template>
 <div class="resource-workspace">
  <div class="page-heading"><div><h1>资源下载</h1><p>检索在线资源、下载到指定目录，或登记已有本地文件。</p></div><span class="outline-tag">文件由本地目录管理</span></div>
  <div class="resource-tabs" role="group" aria-label="资源类型"><button v-for="t in types" :key="t.kind" :class="{chosen:kind===t.kind}" :aria-pressed="kind===t.kind" @click="selectType(t.kind)">{{t.name}}</button></div>
  <div v-if="error" class="alert error" role="alert">{{error}}<button aria-label="关闭错误" @click="error=''"><X :size="16"/></button></div>
  <div v-if="notice" class="alert success" role="status">{{notice}}</div>
  <div class="resource-columns">
   <section class="panel acquisition-panel">
    <template v-if="kind==='boundary'">
     <div class="section-title">区域边界 <span>DataV</span></div>
     <form class="boundary-search" @submit.prevent="search"><input v-model="query" aria-label="地名或行政区代码" placeholder="输入地名或代码，例如 西安、朝阳区、610100" required maxlength="80"/><button class="primary" :disabled="searching"><Search :size="15"/>{{searching?'检索中…':'检索'}}</button></form>
     <p class="field-help">支持国家、省、市、区县；同名地区通过上级区划区分。乡镇、村界暂无数据。</p>
     <div class="boundary-results" aria-label="地名检索结果" :aria-busy="searching">
      <button v-for="r in visibleMatches" :key="r.adcode" :class="{chosen:selected?.adcode===r.adcode}" :aria-pressed="selected?.adcode===r.adcode" @click="selected=r;children=false"><span><strong>{{r.name}}</strong><small>{{r.ancestors||'国家边界'}}</small></span><span>{{levelNames[r.level]||r.level}} · {{r.adcode}}</span></button>
      <div v-if="!matches.length" class="boundary-placeholder">{{searching?'正在读取 DataV 地名索引…':searched?'没有匹配结果，请换一个地名或行政区代码。':'检索地名后，选择需要下载的区域。'}}</div>
     </div>
     <div v-if="matches.length>4" class="resource-pagination"><button class="ghost" :disabled="resultPage===1" @click="resultPage--">上一页</button><span>{{resultPage}} / {{Math.ceil(matches.length/4)}} · {{matches.length}} 项（最多 100 项）</span><button class="ghost" :disabled="resultPage*4>=matches.length" @click="resultPage++">下一页</button></div>
     <label v-if="selected&&selected.level!=='district'" class="checkbox"><input v-model="children" type="checkbox"/>下载下一级行政区边界集合</label>
    </template>
    <template v-else>
     <div class="section-title">文件直链下载 <span>{{types.find(t=>t.kind===kind)?.name}}</span></div>
     <p class="resource-description">{{kind==='imagery'?'下载 GeoTIFF、影像压缩包或已有瓦片数据。':kind==='terrain'?'下载 DEM GeoTIFF 或已有地形压缩包。':kind==='tileset'?'下载完整 3D Tiles 资源压缩包。':kind==='model'?'下载 GLB 或包含 glTF、纹理和 bin 的完整压缩包。':'下载 PNG、JPG、SVG 等图片文件。'}} 此入口下载单个文件，不递归抓取瓦片或模型依赖。</p>
     <label for="resource-url">HTTP / HTTPS 文件地址</label><input id="resource-url" v-model="url" placeholder="https://…" type="url"/>
     <label for="resource-filename">保存文件名（含扩展名）</label><input id="resource-filename" v-model="filename" placeholder="例如 imagery.tif、terrain.tif 或 scene.zip" maxlength="180"/>
    </template>
    <form class="resource-destination" @submit.prevent="download"><label for="download-directory">下载到本地目录</label><div class="path-input"><input id="download-directory" v-model="directory" placeholder="选择或输入绝对目录路径" required/><button type="button" class="ghost" :disabled="busy" @click="chooseDirectory"><FolderOpen :size="15"/>选择</button></div><div class="resource-download-footer"><small>{{kind==='boundary'?selected?.name?selected.name+' · GeoJSON':'请先检索并选择区域':'压缩包下载后请自行解压，登记完整目录。'}}</small><button class="primary" :disabled="busy||!directory||(kind==='boundary'?!selected:!url||!filename)"><Download :size="16"/>下载到本地</button></div></form>
   </section>
   <section class="panel local-resources-panel">
    <div class="section-title">本地资源 <button class="ghost" :disabled="busy" @click="refresh"><RefreshCw :size="14"/>检查</button></div>
    <form class="resource-register" @submit.prevent="action(()=>api.registerResource(kind,localPath),'本地资源已登记，文件保留在原目录。')"><label for="local-resource-path">登记已有文件或目录</label><input id="local-resource-path" v-model="localPath" required placeholder="本地绝对路径"/><div><button type="button" class="ghost" :disabled="busy" @click="chooseLocal('file')">选择文件</button><button type="button" class="ghost" :disabled="busy" @click="chooseLocal('directory')">选择目录</button><button class="primary" :disabled="busy||!localPath"><Plus :size="14"/>登记</button></div></form>
    <div class="local-resource-list"><article v-for="r in visible" :key="r.id"><div class="local-resource-title"><strong>{{r.name}}</strong><span class="badge" :class="r.status==='ready'&&r.exists?'valid':r.status==='failed'||r.exists===false?'invalid':'idle'">{{status(r)}}</span></div><code :title="r.path">{{r.path}}</code><small v-if="r.status==='downloading'">{{size(r.received)}} / {{r.size?size(r.size):'大小未知'}}</small><progress v-if="r.status==='downloading'&&r.size" :value="r.received" :max="r.size" aria-label="下载进度"/><p v-if="r.error" class="text-error">{{r.error}}</p><div class="local-resource-actions"><button v-if="r.status==='downloading'" class="ghost" @click="action(()=>api.cancelDownload(r.id))">取消下载</button><template v-else><button v-if="r.exists" class="ghost" @click="action(()=>api.reveal(r.path))">打开</button><button v-if="r.exists&&!r.isDirectory&&/\.(tiff?|vrt)$/i.test(r.path)&&(kind==='imagery'||kind==='terrain')" class="ghost" @click="emit('process',kind,r.path)">加工</button><button v-if="r.exists&&kind!=='boundary'" class="ghost" @click="emit('publish',kind,r.isDirectory?r.path:r.path.slice(0,Math.max(r.path.lastIndexOf('/'),r.path.lastIndexOf('\\')))||'/')">发布</button><button class="ghost" @click="askForget(r)">移除索引</button></template></div></article><div v-if="!filtered.length" class="boundary-placeholder">该类型暂无本地资源</div></div>
    <div v-if="filtered.length" class="resource-pagination"><button class="ghost" :disabled="page<=1" @click="page--">上一页</button><span>{{Math.min(page,pages)}} / {{pages}} · {{filtered.length}} 项</span><button class="ghost" :disabled="page>=pages" @click="page++">下一页</button></div>
   </section>
  </div>
  <dialog ref="confirmation" class="service-dialog removal-dialog" aria-labelledby="forget-title" @cancel="busy&&$event.preventDefault()"><div class="advanced-body"><h2 id="forget-title">确认移除资源索引？</h2><p class="resource-description">{{pending?.name}}<br>仅移除路径记录，磁盘文件保留。</p><div class="dialog-footer"><button data-cancel class="ghost" :disabled="busy" @click="confirmation?.close()">取消</button><button class="primary destructive" :disabled="busy" @click="forget">确认移除</button></div></div></dialog>
 </div>
</template>
