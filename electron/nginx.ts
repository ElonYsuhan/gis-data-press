import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import type { Publication, Settings } from '../shared/contracts'
const execute=promisify(execFile)
export function nginxQuote(value:string):string {
  if(/[\r\n\0]/.test(value)) throw new Error('目录路径包含不支持的控制字符')
  return '"'+value.replace(/\\/g,'/').replace(/\$/g,'\\$').replace(/"/g,'\\"')+'"'
}
export function generateConfig(settings:Settings,publications:Publication[]):string {
  const locations=publications.map(p=>{
    if(!p.enabled||!p.valid)return `location ^~ ${p.mount} { return 503; }`
    const alias=nginxQuote(p.directory.replace(/[\\/]$/,'')+'/')
    const terrain=(p as Publication & {compressed?:boolean}).compressed
    return `location ^~ ${p.mount} {
      alias ${alias};
      ${process.platform!=='win32'?'disable_symlinks on;':''}
      autoindex off;
      location ~ (^|/)\\. { deny all; }
      add_header Access-Control-Allow-Origin "*" always;
      add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
      add_header Access-Control-Expose-Headers "Content-Length, Content-Range, ETag" always;
      add_header Cache-Control "public, max-age=${settings.cacheSeconds}, must-revalidate" always;
      if ($request_method = OPTIONS) { return 204; }
      limit_except GET HEAD OPTIONS { deny all; }
      ${terrain?'add_header Content-Encoding gzip;':''}
      ${p.kind==='terrain'?`location ~ \\.json$ { add_header Access-Control-Allow-Origin "*" always; add_header Cache-Control "no-cache" always; }`:''}
    }`
  }).join('\n')
  return `worker_processes auto;
pid nginx.pid;
error_log logs/error.log warn;
events { worker_connections 4096; }
http {
  types { text/html html; application/json json gltf; image/png png; image/jpeg jpg jpeg; image/webp webp; image/svg+xml svg; image/gif gif; image/avif avif; model/gltf-binary glb; application/vnd.quantized-mesh terrain; application/octet-stream b3dm i3dm pnts cmpt bin ktx ktx2; }
  default_type application/octet-stream;
  log_format gis '$remote_addr [$time_local] "$request" $status $body_bytes_sent $request_time';
  access_log logs/access.log gis buffer=32k flush=1s;
  sendfile on; tcp_nopush on; tcp_nodelay on;
  keepalive_timeout 30; server_tokens off;
  client_body_temp_path temp/client; proxy_temp_path temp/proxy; fastcgi_temp_path temp/fastcgi; uwsgi_temp_path temp/uwsgi; scgi_temp_path temp/scgi;
  open_file_cache off;
  server {
    listen ${settings.host}:${settings.port};
    server_name localhost;
    location = /_gis_status { allow 127.0.0.1; deny all; stub_status; access_log off; }
    ${locations}
    location / { return 404; }
  }
}`
}
export class NginxServer {
  running=false; error=''; private executable=''
  constructor(readonly directory:string){}
  async adopt(binary:string,port:number):Promise<boolean>{
    try{const pid=Number((await readFile(path.join(this.directory,'nginx.pid'),'utf8')).trim());if(!Number.isInteger(pid)||pid<=0)return false;process.kill(pid,0);this.executable=binary;this.running=true;if(await this.healthy(port))return true}catch{}
    this.running=false;return false
  }
  async command(binary:string,args:string[]):Promise<string> {
    const {stdout,stderr}=await execute(binary,['-p',this.directory+path.sep,'-c','nginx.conf',...args],{timeout:15000,maxBuffer:1024*1024,windowsHide:true})
    return stdout+stderr
  }
  async apply(binary:string,settings:Settings,publications:Publication[]):Promise<void> {
    if(this.running && binary!==this.executable) throw new Error('请先停止服务，再切换 Nginx 引擎')
    await mkdir(path.join(this.directory,'logs'),{recursive:true})
    for(const name of ['client','proxy','fastcgi','uwsgi','scgi']) await mkdir(path.join(this.directory,'temp',name),{recursive:true})
    const config=path.join(this.directory,'nginx.conf'); const candidate=path.join(this.directory,'candidate.conf')
    await writeFile(candidate,generateConfig(settings,publications))
    try {
      await execute(binary,['-p',this.directory+path.sep,'-c','candidate.conf','-t'],{timeout:15000,windowsHide:true})
      let previous:string|undefined; try{previous=await readFile(config,'utf8')}catch{}
      await rename(candidate,config)
      try {if(this.running)await this.command(binary,['-s','reload'])}
      catch(error){if(previous!==undefined)await writeFile(config,previous);throw error}
      this.error=''
    }catch(error){this.error=error instanceof Error?error.message:String(error);throw error}
  }
  async start(binary:string,settings:Settings,publications:Publication[]):Promise<void> {
    if(this.running)return
    await this.apply(binary,settings,publications)
    try {
      if(process.platform==='win32'){
        const child=spawn(binary,['-p',this.directory+path.sep,'-c','nginx.conf'],{cwd:this.directory,detached:true,stdio:'ignore',windowsHide:true})
        await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve)});child.unref()
        let ready=false;for(let i=0;i<30;i++){try{const response=await fetch(`http://127.0.0.1:${settings.port}/_gis_status`,{signal:AbortSignal.timeout(500)});ready=response.ok&&(await response.text()).includes('Active connections:')}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,100))}
        if(!ready){await this.command(binary,['-s','quit']).catch(()=>{});throw new Error('Nginx 启动后未响应，请检查日志')}
      }else await this.command(binary,[])
      this.executable=binary;this.running=true;this.error=''
    }catch(error){this.error=error instanceof Error?error.message:String(error);throw error}
  }
  async stop():Promise<void> {
    if(!this.running)return
    await this.command(this.executable,['-s','quit']);this.running=false
  }
  async healthy(port:number):Promise<boolean> {
    if(!this.running)return false
    try{const r=await fetch(`http://127.0.0.1:${port}/_gis_status`,{signal:AbortSignal.timeout(2000)});return r.ok&&(await r.text()).includes('Active connections:')}catch{return false}
  }
}
