import { spawn } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Manager } from './manager'
export interface ServiceEndpoint {pid:number;port:number;token:string}
export async function serviceRequest(endpoint:ServiceEndpoint,name:string,args:unknown[]=[]):Promise<any>{
 const response=await fetch(`http://127.0.0.1:${endpoint.port}/${name}`,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(name==='inspect'?65000:30000)})
 const result=await response.json();if(!response.ok)throw new Error(result.error??'后台服务请求失败');return result.result
}
export async function connectService(dataDirectory:string,project:string,resources:string):Promise<Manager>{
 const endpointFile=path.join(dataDirectory,'service.json')
 async function existing():Promise<ServiceEndpoint|undefined>{try{const endpoint=JSON.parse(await readFile(endpointFile,'utf8')) as ServiceEndpoint;await serviceRequest(endpoint,'ping');return endpoint}catch{return undefined}}
 let endpoint=await existing()
 if(endpoint){
  const info=await serviceRequest(endpoint,'ping')
  if((info.protocol??1)<3){
   const snapshot=await serviceRequest(endpoint,'snapshot')
   if(snapshot.jobs.some((job:{status:string})=>['queued','running'].includes(job.status)))throw new Error('后台有加工任务正在执行，请待任务完成后重新打开软件以升级资源下载功能')
   if((info.protocol??1)>=2&&(await serviceRequest(endpoint,'listResources')).some((r:{status:string})=>r.status==='downloading'))throw new Error('后台有资源正在下载，请待下载完成后重新打开软件以升级')
   if(info.pid!==endpoint.pid)throw new Error('后台进程身份校验失败')
   process.kill(endpoint.pid,'SIGTERM')
   for(let attempt=0;attempt<100;attempt++){if(!await existing()){endpoint=undefined;break}await new Promise(resolve=>setTimeout(resolve,100))}
   if(endpoint)throw new Error('旧后台尚未退出，请稍后重新打开软件')
  }
 }
 if(!endpoint){
  await mkdir(dataDirectory,{recursive:true});const output=await open(path.join(dataDirectory,'service.log'),'a',0o600)
  try{const child=spawn(process.execPath,[path.join(project,'dist-electron','service.cjs'),dataDirectory,project,resources],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},detached:true,stdio:['ignore',output.fd,output.fd],windowsHide:true});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref()}finally{await output.close()}
  for(let attempt=0;attempt<100;attempt++){endpoint=await existing();if(endpoint)break;await new Promise(resolve=>setTimeout(resolve,100))}
 }
 if(!endpoint)throw new Error('发布后台启动失败，请检查 service.log')
 const connected=endpoint
 // Closing the management client must never stop the independent publishing daemon.
 return new Proxy({} as Manager,{get:(_target,name:string)=>name==='then'?undefined:name==='close'?async()=>{}:(...args:unknown[])=>serviceRequest(connected,name,args)})
}
