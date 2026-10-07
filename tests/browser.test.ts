import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startBrowserUI } from '../electron/browser'
test('browser management serves UI and requires same-origin authenticated requests',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'gis-browser-'));await writeFile(path.join(dir,'index.html'),'<h1>GIS</h1>')
 const server=await startBrowserUI(dir,{snapshot:()=>({ok:true})});const url=new URL(server.url);const token=url.hash.slice(1)
 try{
  assert.equal(await (await fetch(url.origin)).text(),'<h1>GIS</h1>')
  assert.equal((await fetch(url.origin+'/api/snapshot',{method:'POST',body:'[]'})).status,403)
  const headers={Origin:url.origin,Authorization:`Bearer ${token}`}
  assert.deepEqual(await (await fetch(url.origin+'/api/snapshot',{method:'POST',headers,body:'[]'})).json(),{result:{ok:true}})
  assert.equal((await fetch(url.origin+'/api/snapshot',{method:'POST',headers:{...headers,Origin:'http://evil.invalid'},body:'[]'})).status,403)
  assert.equal((await fetch(url.origin+'/api/constructor',{method:'POST',headers,body:'[]'})).status,404)
 }finally{await server.close();await assert.rejects(fetch(url.origin));await rm(dir,{recursive:true,force:true})}
})
