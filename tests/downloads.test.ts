import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Downloads } from '../electron/downloads'
const polygon={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'西安市'},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}}]}
async function finish(d:Downloads){for(let i=0;i<100;i++){const rows=await d.list();if(rows.every(r=>r.status!=='downloading'))return rows;await new Promise(r=>setTimeout(r,10))}throw new Error('下载未完成')}
test('DataV 同名检索、下级边界下载、文件保护和路径索引失效',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gis-download-'));const requested:string[]=[]
 const fake=async(url:string|URL|Request)=>{requested.push(String(url));return new Response(JSON.stringify(String(url).endsWith('all.json')?[{adcode:100000,name:'中国',level:'country',parent:null},{adcode:610000,name:'陕西省',level:'province',parent:100000},{adcode:610100,name:'西安市',level:'city',parent:610000},{adcode:110105,name:'朝阳区',level:'district',parent:100000},{adcode:220104,name:'朝阳区',level:'district',parent:610100}]:polygon))}
 const d=new Downloads(path.join(root,'state'),fake as typeof fetch)
 try{await d.initialize();assert.equal((await d.search('朝阳区')).length,2);assert.equal((await d.search('西安'))[0].ancestors,'中国 / 陕西省');await d.start({kind:'boundary',directory:root,url:'',filename:'',adcode:610100,children:true});const [r]=await finish(d);assert.equal(r.status,'ready');assert.ok(requested.some(u=>u.endsWith('610100_full.json')));assert.deepEqual(JSON.parse(await readFile(r.path,'utf8')),polygon);await assert.rejects(d.start({kind:'boundary',directory:root,url:'',filename:'',adcode:610100,children:true}),/同名文件/);const restored=new Downloads(path.join(root,'state'),fake as typeof fetch);await restored.initialize();assert.equal((await restored.list())[0].exists,true);await restored.forget(r.id);assert.deepEqual(JSON.parse(await readFile(r.path,'utf8')),polygon);await unlink(r.path);assert.equal((await d.list())[0].exists,false)}finally{await d.close();await rm(root,{recursive:true,force:true})}
})
test('无效边界不落成品文件，普通文件直链下载并拒绝路径穿越',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gis-download-'));const d=new Downloads(path.join(root,'state'),(async()=>new Response('hello')) as typeof fetch)
 try{await d.initialize();await assert.rejects(d.start({kind:'image',directory:root,url:'https://example.org/icon.png',filename:'../escape.png'}),/文件名/);await d.start({kind:'image',directory:root,url:'https://example.org/icon.png',filename:'icon.png'});assert.equal((await finish(d))[0].status,'ready');assert.equal(await readFile(path.join(root,'icon.png'),'utf8'),'hello');assert.ok(!(await readdir(root)).some(f=>f.endsWith('.part')))}finally{await d.close();await rm(root,{recursive:true,force:true})}
})
test('取消下载清理临时文件且不产生完成文件',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gis-download-'));const fake=async(_url:unknown,options:any)=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));options.signal.addEventListener('abort',()=>c.error(new Error('aborted')),{once:true})}}));const d=new Downloads(path.join(root,'state'),fake as typeof fetch)
 try{await d.initialize();const id=await d.start({kind:'terrain',directory:root,url:'https://example.org/dem.tif',filename:'dem.tif'});await new Promise(r=>setTimeout(r,20));await d.cancel(id);assert.equal((await d.list())[0].status,'cancelled');assert.ok(!(await readdir(root)).some(f=>f==='dem.tif'||f.endsWith('.part')))}finally{await d.close();await rm(root,{recursive:true,force:true})}
})
