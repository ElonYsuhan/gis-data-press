import { access, mkdir, readFile, writeFile, rename, realpath, stat, open } from 'node:fs/promises'
import { constants, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { Engine, Inspection, Job, JobRequest, Publication, Settings, Snapshot } from '../shared/contracts'
import { assertNoOverlap, normalizeMount, scanDirectory } from './catalog'
import { NginxServer } from './nginx'
import { Downloads } from './downloads'
import type { AssetKind, DownloadRequest } from '../shared/contracts'

export async function findExecutable(value:string,candidates:string[]=[]):Promise<string> {
  for(const candidate of value?[value]:candidates) {
    const options=candidate.includes('/')||candidate.includes('\\')?[candidate]:(process.env.PATH??'').split(path.delimiter).map(p=>path.join(p,candidate))
    for(const option of options) {try{await access(option,process.platform==='win32'?constants.F_OK:constants.X_OK); if((await stat(option)).isFile())return option}catch{}}
  }
  return ''
}
export function validateSettings(value:Settings):Settings {
  if(!value||!Number.isInteger(value.port)||value.port<1024||value.port>65535)throw new Error('端口必须是 1024–65535 的整数')
  if(!['127.0.0.1','0.0.0.0'].includes(value.host))throw new Error('监听地址无效')
  if(!Number.isInteger(value.cacheSeconds)||value.cacheSeconds<0||value.cacheSeconds>86400)throw new Error('缓存时间应为 0–86400 秒')
  for(const key of ['nginx','python','gdal','terrain','osgb'] as const)if(typeof value[key]!=='string'||/[\n\r\0]/.test(value[key]))throw new Error('引擎路径无效')
  const taskConcurrency=value.taskConcurrency??2;const workerBudget=value.workerBudget??4
  if(!Number.isInteger(taskConcurrency)||taskConcurrency<1||taskConcurrency>4)throw new Error('同时运行任务数必须是 1–4')
  if(!Number.isInteger(workerBudget)||workerBudget<1||workerBudget>16)throw new Error('总并行预算必须是 1–16')
  return {...value,taskConcurrency,workerBudget}
}
export function validateJob(value:JobRequest):JobRequest {
  if(!value||!['imagery','terrain','osgb'].includes(value.kind))throw new Error('任务类型无效')
  for(const key of ['input','output','sourceCrs'] as const)if(typeof value[key]!=='string'||/[\0\r\n]/.test(value[key]))throw new Error('任务路径或坐标系无效')
  if(!path.isAbsolute(value.input)||!path.isAbsolute(value.output))throw new Error('输入和输出必须是绝对路径')
  if(!Number.isInteger(value.minZoom)||!Number.isInteger(value.maxZoom)||value.minZoom<0||value.maxZoom>22||value.minZoom>value.maxZoom)throw new Error('层级必须满足 0 ≤ 最小层级 ≤ 最大层级 ≤ 22')
  if(value.kind==='terrain'&&value.minZoom!==0)throw new Error('Cesium 地形必须从 0 级生成，以保证根瓦片可用')
  if(!Number.isInteger(value.workers)||value.workers<1||value.workers>8)throw new Error('并行进程必须为 1–8')
  if(typeof value.scale!=='boolean'||!['ellipsoid','unknown'].includes(value.verticalDatum))throw new Error('处理参数无效')
  if((value.longitude===undefined)!==(value.latitude===undefined))throw new Error('定位经纬度必须同时填写')
  if(value.longitude!==undefined&&(!Number.isFinite(value.longitude)||Math.abs(value.longitude)>180||!Number.isFinite(value.latitude)||Math.abs(value.latitude!)>90))throw new Error('经纬度超出范围')
  return {...value}
}
export class Manager {
  private downloads:Downloads
  listResources(){return this.downloads.list()}
  searchBoundaries(q:string){return this.downloads.search(q)}
  downloadResource(r:DownloadRequest){return this.downloads.start(r)}
  registerResource(kind:AssetKind,p:string){return this.downloads.register(kind,p)}
  cancelDownload(id:string){return this.downloads.cancel(id)}
  forgetResource(id:string){return this.downloads.forget(id)}
  publications:Publication[]=[];jobs:Job[]=[];settings:Settings
  nginx:NginxServer; engines:Engine[]=[];private queue:Promise<unknown>=Promise.resolve();private runningJobs=new Map<string,{job:Job;child?:ChildProcess;completion?:Promise<void>}>();private watchers:FSWatcher[]=[];private dirtyTimer?:ReturnType<typeof setTimeout>;private monitor?:ReturnType<typeof setInterval>;private stopping=false;private dockerPath=''
  constructor(readonly dataDirectory:string,readonly project:string,readonly resources:string,readonly log:(message:string)=>void=console.log) {
    this.downloads=new Downloads(dataDirectory)
    this.settings={port:8088,host:'127.0.0.1',nginx:'',python:'',gdal:'',terrain:'',osgb:'',cacheSeconds:0,taskConcurrency:2,workerBudget:4}
    this.nginx=new NginxServer(path.join(dataDirectory,'nginx'))
  }
  private locked<T>(action:()=>Promise<T>):Promise<T> {const next=this.queue.then(action,action);this.queue=next.catch(()=>{});return next}
  async initialize():Promise<void> {
    await mkdir(this.dataDirectory,{recursive:true})
    try{const state=JSON.parse(await readFile(path.join(this.dataDirectory,'state.json'),'utf8'));this.settings=validateSettings(state.settings);this.publications=state.publications??[];this.jobs=(state.jobs??[]).map((job:Job)=>['running','queued'].includes(job.status)?{...job,status:'interrupted',stage:'应用退出时任务中断，请重新提交'}:job)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.log(`配置读取失败：${String(error)}`)}
    await this.downloads.initialize()
    await this.resolveEngines()
    const nginx=this.engines.find(e=>e.id==='nginx');if(nginx?.available)await this.nginx.adopt(nginx.path,this.settings.port)
    await this.refresh()
    this.resetWatchers()
    this.monitor=setInterval(()=>{void this.refresh().catch(error=>this.log(String(error)))},30000)
  }
  async resolveEngines():Promise<void> {
    const bundle=path.join(this.resources===this.project?path.join(this.project,'resources'):this.resources,'engines');const ext=process.platform==='win32'?'.exe':''
    const definitions=[
      ['nginx','Nginx 静态服务',[path.join(bundle,'nginx','nginx'+ext),'nginx'+ext]],
      ['python','Python 数据处理',[path.join(bundle,'python','gis-worker','gis-worker'+ext),path.join(bundle,'gis-worker'+ext),path.join(this.project,'.venv','bin','python'),'python3','python']],
      ['gdal','GDAL 影像切片',[path.join(bundle,'gdal2tiles'+ext),'gdal2tiles','gdal2tiles.py']],
      ['terrain','CTB Quantized Mesh',[path.join(bundle,'ctb-tile'+ext),'ctb-tile'+ext]],
      ['osgb','OSGB → 3D Tiles',[path.join(bundle,'3dtile'+ext),'3dtile'+ext,'_3dtile'+ext]]
    ] as const
    this.dockerPath=await findExecutable('', ['docker','/usr/local/bin/docker'])
    this.engines=await Promise.all(definitions.map(async([id,label,candidates])=>{let resolved=await findExecutable(this.settings[id],Array.from(candidates));if(id==='terrain' && !resolved && (!this.settings.terrain || this.settings.terrain==='docker://ctb') && this.dockerPath){try{await new Promise<void>((resolve,reject)=>execFile(this.dockerPath,['image','inspect','ghcr.io/tum-gis/ctb-quantized-mesh:alpine'],{timeout:5000},error=>error?reject(error):resolve()));resolved='docker://ctb'}catch{}}
    return{id,label,path:resolved,available:!!resolved,detail:resolved?'可执行文件已找到；转换兼容性将在任务运行时检查':'未找到引擎，请配置本地可执行文件'}}))
  }
  private engine(id:string):string {const engine=this.engines.find(e=>e.id===id);if(!engine?.available)throw new Error(`缺少 ${engine?.label??id}，请先打开引擎设置`);return engine.path}
  async persist():Promise<void> {
    const file=path.join(this.dataDirectory,'state.json');await writeFile(file+'.tmp',JSON.stringify({settings:this.settings,publications:this.publications,jobs:this.jobs},null,2));await rename(file+'.tmp',file)
  }
  async refresh():Promise<void> {return this.locked(async()=>{
    const previous=JSON.stringify(this.publications.map(p=>[p.valid,(p as any).compressed]))
    for(const publication of this.publications)Object.assign(publication,await scanDirectory(publication.directory,publication.kind))
    if(this.nginx.running && !(await this.nginx.healthy(this.settings.port))){this.nginx.running=false;this.nginx.error='Nginx 未响应，请检查日志后重新启动'}
    if(this.nginx.running && (this.nginx.error || previous!==JSON.stringify(this.publications.map(p=>[p.valid,(p as any).compressed]))))await this.nginx.apply(this.engine('nginx'),this.settings,this.publications)
    await this.persist()
  })}
  private resetWatchers():void {
    for(const watcher of this.watchers)watcher.close();this.watchers=[]
    for(const p of this.publications){try{const watcher=watch(p.directory,{recursive:process.platform!=='linux'},()=>{if(this.dirtyTimer)clearTimeout(this.dirtyTimer);this.dirtyTimer=setTimeout(()=>{void this.refresh().catch(e=>this.log(String(e)))},1000)});watcher.on('error',()=>{});this.watchers.push(watcher)}catch{}}
  }
  async savePublication(value:Pick<Publication,'name'|'directory'|'mount'|'kind'>&{id?:string}):Promise<void>{return this.locked(async()=>{
    if(!value||typeof value.name!=='string'||!value.name.trim()||value.name.length>80)throw new Error('请输入 1–80 字的服务名称')
    if(!['imagery','terrain','tileset','model','image'].includes(value.kind))throw new Error('服务类型无效')
    if(typeof value.directory!=='string'||!path.isAbsolute(value.directory))throw new Error('请选择本地绝对目录')
    const directory=await realpath(value.directory);const mount=normalizeMount(value.mount);assertNoOverlap(this.publications,mount,value.id)
    for(const job of this.jobs.filter(j=>['queued','running'].includes(j.status)))if(pathsOverlap(directory,job.request.output))throw new Error('目录正在加工，请等待任务完成再发布')
    const old=this.publications;const existing=old.find(p=>p.id===value.id)
    if(value.id&&!existing)throw new Error('服务不存在')
    const publication={id:existing?.id??randomUUID(),name:value.name.trim(),directory,mount,kind:value.kind,enabled:existing?.enabled??true,...await scanDirectory(directory,value.kind)}
    this.publications=existing?old.map(p=>p.id===existing.id?publication:p):[...old,publication]
    try{if(this.nginx.running)await this.nginx.apply(this.engine('nginx'),this.settings,this.publications);await this.persist()}catch(error){this.publications=old;throw error}
    this.resetWatchers()
  })}
  async togglePublication(id:string):Promise<void>{return this.locked(async()=>{const p=this.publications.find(p=>p.id===id);if(!p)throw new Error('服务不存在');p.enabled=!p.enabled;try{if(this.nginx.running)await this.nginx.apply(this.engine('nginx'),this.settings,this.publications);await this.persist()}catch(e){p.enabled=!p.enabled;throw e}})}
  async removePublication(id:string):Promise<void>{return this.locked(async()=>{const old=this.publications;this.publications=old.filter(p=>p.id!==id);try{if(this.nginx.running)await this.nginx.apply(this.engine('nginx'),this.settings,this.publications);await this.persist()}catch(e){this.publications=old;throw e}this.resetWatchers()})}
  async saveSettings(value:Settings):Promise<void>{return this.locked(async()=>{const next=validateSettings(value);if(this.nginx.running&&(next.port!==this.settings.port||next.host!==this.settings.host||next.nginx!==this.settings.nginx))throw new Error('修改端口、监听地址或 Nginx 路径前，请先停止服务');const old=this.settings;this.settings=next;try{await this.resolveEngines();if(this.nginx.running)await this.nginx.apply(this.engine('nginx'),next,this.publications);await this.persist();setTimeout(()=>void this.pump(),0)}catch(e){this.settings=old;await this.resolveEngines();throw e}})}
  async server(action:'start'|'stop'):Promise<void>{if(action==='start')await this.refresh();return this.locked(async()=>{if(action==='start')await this.nginx.start(this.engine('nginx'),this.settings,this.publications);else if(action==='stop')await this.nginx.stop();else throw new Error('操作无效')})}
  private worker(payload:unknown,onEvent?:(event:any)=>void,onChild?:(child:ChildProcess)=>void):Promise<any>{
    const python=this.engine('python');const bundled=path.basename(python).startsWith('gis-worker');const script=path.join(this.resources,'python','worker.py')
    return new Promise((resolve,reject)=>{
      const child=spawn(python,bundled?[]:[script],{stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32',env:{...process.env,PYTHONUNBUFFERED:'1'}})
      onChild?.(child);let buffer='';let result:any;let failure='';let stderr='';let timeout:ReturnType<typeof setTimeout>|undefined
      if(!onEvent)timeout=setTimeout(()=>{child.kill();reject(new Error('读取数据超时，请检查文件和依赖'))},60000)
      child.stdout?.on('data',(chunk:Buffer)=>{buffer+=chunk.toString();if(buffer.length>1024*1024){child.kill();reject(new Error('处理引擎输出异常'));return}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const event=JSON.parse(line);if(event.event==='result')result=event.value;if(event.event==='error')failure=event.message;onEvent?.(event)}catch{}}})
      child.stderr?.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-8000)})
      child.on('error',error=>{if(timeout)clearTimeout(timeout);reject(error)})
      child.on('close',code=>{if(timeout)clearTimeout(timeout);if(code!==0||result===undefined)reject(new Error(failure||stderr||'处理引擎中断'));else resolve(result)})
      child.stdin?.on('error',()=>{});child.stdin?.end(JSON.stringify(payload))
    })
  }
  async inspect(filename:string):Promise<Inspection>{if(typeof filename!=='string'||!path.isAbsolute(filename))throw new Error('请选择本地文件');return this.worker({action:'inspect',path:filename})}
  async submit(value:JobRequest):Promise<string>{return this.locked(async()=>{
    const request=validateJob(value);request.input=await realpath(request.input);request.output=await canonicalPath(request.output);this.engine('python');this.engine(request.kind==='imagery'?'gdal':request.kind==='terrain'?'terrain':'osgb')
    const output=path.resolve(request.output)
    if(this.publications.some(p=>pathsOverlap(output,p.directory)))throw new Error('输出目录与已登记的发布目录重叠，请使用新的空目录')
    if(this.jobs.some(j=>['queued','running'].includes(j.status)&&pathsOverlap(j.request.output,output)))throw new Error('该输出目录已有待处理任务')
    const job:Job={id:randomUUID(),request,status:'queued',stage:'等待执行',logs:[],createdAt:new Date().toISOString()};this.jobs.unshift(job);await this.persist();setTimeout(()=>void this.pump(),0);return job.id
  })}
  private async pump():Promise<void>{
    if(this.stopping)return
    while(this.runningJobs.size<this.settings.taskConcurrency){
      const used=[...this.runningJobs.values()].reduce((n,r)=>n+(r.job.effectiveWorkers??1),0)
      const free=this.settings.workerBudget-used;if(free<1)return
      const job=this.jobs.slice().reverse().find(j=>j.status==='queued');if(!job)return
      job.status='running';job.stage='启动加工引擎';job.startedAt=new Date().toISOString();job.effectiveWorkers=Math.min(job.request.workers,free)
      const running:{job:Job;child?:ChildProcess;completion?:Promise<void>}={job};this.runningJobs.set(job.id,running)
      running.completion=this.runJob(job,running)
    }
  }
  private stopChild(child:ChildProcess){if(!child.pid)return;const pid=child.pid;if(process.platform==='win32')execFile('taskkill',['/pid',String(pid),'/T','/F']);else{try{process.kill(-pid,'SIGTERM')}catch{}const timer=setTimeout(()=>{try{process.kill(-pid,'SIGKILL')}catch{}},5000);child.once('close',()=>clearTimeout(timer))}}
  private async runJob(job:Job,running:{job:Job;child?:ChildProcess}):Promise<void>{
    try{
      await this.locked(()=>this.persist())
      if(isCancelled(job))return
      await this.worker({action:'process',request:{...job.request,workers:job.effectiveWorkers},engines:{...Object.fromEntries(this.engines.map(e=>[e.id,e.path])),docker:this.dockerPath}},event=>{
        if(isCancelled(job))return
        if(event.event==='stage'){job.stage=event.message;job.progress=undefined}
        if(event.event==='progress'&&Number.isFinite(event.percent))job.progress={percent:Math.max(0,Math.min(100,event.percent)),label:event.label}
        if(event.event==='log'){job.logs.push(event.message);if(job.logs.length>500)job.logs.shift()}
      },child=>{running.child=child;if(isCancelled(job))this.stopChild(child)})
      if(!isCancelled(job)){job.status='succeeded';job.stage='加工完成，可以发布输出目录';job.progress={percent:100,label:'已完成'}}
    }catch(error){if(!isCancelled(job)){job.status='failed';job.error=String(error instanceof Error?error.message:error);job.stage=job.error}}
    finally{job.finishedAt=new Date().toISOString();this.runningJobs.delete(job.id);await this.locked(()=>this.persist());if(!this.stopping)void this.pump()}
  }
  async cancel(id:string):Promise<void>{const job=this.jobs.find(j=>j.id===id);if(!job||!['queued','running'].includes(job.status))return;job.status='cancelled';job.stage='已取消';job.finishedAt=new Date().toISOString();const running=this.runningJobs.get(id);if(running?.child)this.stopChild(running.child);await this.locked(()=>this.persist())}
  async snapshot():Promise<Snapshot>{const addresses=[`http://127.0.0.1:${this.settings.port}`];if(this.settings.host==='0.0.0.0')for(const list of Object.values(networkInterfaces()))for(const address of list??[])if(address.family==='IPv4'&&!address.internal)addresses.push(`http://${address.address}:${this.settings.port}`);return {publications:this.publications,jobs:this.jobs,settings:this.settings,engines:this.engines,server:{running:this.nginx.running,error:this.nginx.error,addresses},logs:await tail(path.join(this.nginx.directory,'logs','access.log'))}}
  async close(options:{keepPublishing?:boolean}={}):Promise<void>{this.stopping=true;await this.downloads.close();if(this.monitor)clearInterval(this.monitor);if(this.dirtyTimer)clearTimeout(this.dirtyTimer);for(const w of this.watchers)w.close();for(const j of this.jobs.filter(j=>['queued','running'].includes(j.status)))await this.cancel(j.id);await Promise.allSettled([...this.runningJobs.values()].map(r=>r.completion));await this.locked(async()=>{if(!options.keepPublishing)await this.nginx.stop();await this.persist()})}
}
export function pathsOverlap(a:string,b:string):boolean {const normalize=(v:string)=>process.platform==='win32'?path.resolve(v).toLowerCase():path.resolve(v);a=normalize(a);b=normalize(b);return a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep)}
async function tail(filename:string):Promise<string[]>{try{const file=await open(filename,'r');try{const info=await file.stat();const buffer=Buffer.alloc(Math.min(info.size,16384));await file.read(buffer,0,buffer.length,Math.max(0,info.size-buffer.length));return buffer.toString().trim().split('\n').slice(-80)}finally{await file.close()}}catch{return []}}

function isCancelled(job:Job):boolean{return job.status==='cancelled'}

async function canonicalPath(filename:string):Promise<string>{let current=path.resolve(filename);const suffix:string[]=[];while(true){try{return path.join(await realpath(current),...suffix)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=path.dirname(current);if(parent===current)throw error;suffix.unshift(path.basename(current));current=parent}}}
