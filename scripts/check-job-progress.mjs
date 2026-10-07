import { _electron as electron } from 'playwright'
import { mkdtemp,mkdir,writeFile,chmod,rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'
const state=await mkdtemp(path.join(os.tmpdir(),'gis-job-ui-'));const source=path.join(state,'sample.tif');const engine=path.join(state,'progress-engine');const python=path.resolve('.venv/bin/python')
await promisify(execFile)(python,['-c',"import rasterio,numpy as np,sys;from rasterio.transform import from_origin;d=rasterio.open(sys.argv[1],'w',driver='GTiff',width=64,height=64,count=3,dtype='uint8',crs='EPSG:3857',transform=from_origin(11000000,4000000,5,5));d.write(np.full((3,64,64),100,dtype='uint8'));d.close()",source])
await writeFile(engine,`#!${python}\nimport sys,time,pathlib,base64\nfor value in (0,10,50,100):\n sys.stdout.write(str(value)+'...');sys.stdout.flush();time.sleep(2)\np=pathlib.Path(sys.argv[-1])/'0'/'0';p.mkdir(parents=True,exist_ok=True);(p/'0.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII='))\n`);await chmod(engine,0o755)
const app=await electron.launch({executablePath:path.resolve('release/mac-arm64/GIS Data Press.app/Contents/MacOS/GIS Data Press'),args:['--user-data-dir='+path.join(state,'desktop')],env:{...process.env,GIS_PRESS_STATE:state}})
try{
 const page=await app.firstWindow();await page.getByRole('button',{name:'任务中心',exact:false}).first().waitFor();const ids=await page.evaluate(async({source,engine,state})=>{const s=await window.gis.snapshot();await window.gis.saveSettings({...s.settings,gdal:engine,taskConcurrency:2,workerBudget:4});const ids=[];for(let i=0;i<3;i++)ids.push(await window.gis.submit({kind:'imagery',input:source,output:state+'/out'+i,minZoom:0,maxZoom:2,workers:2,sourceCrs:'',scale:false,verticalDatum:'unknown'}));return ids},{source,engine,state});await page.getByRole('button',{name:/任务中心/}).click()
 await page.getByText('10% · 当前阶段').first().waitFor({timeout:20000});const snapshot=await page.evaluate(()=>window.gis.snapshot());assert.equal(snapshot.jobs.filter(j=>j.status==='running').length,2);assert.equal(snapshot.jobs.filter(j=>j.status==='queued').length,1);assert.ok(snapshot.jobs.some(j=>j.progress?.percent===10));assert.ok(snapshot.jobs.filter(j=>j.status==='running').every(j=>j.startedAt&&j.effectiveWorkers===2));await mkdir('output/playwright',{recursive:true});await page.screenshot({path:'output/playwright/jobs-progress.png'})
 await page.evaluate(id=>window.gis.cancel(id),ids[0]);await page.waitForFunction(id=>window.gis.snapshot().then(s=>s.jobs.find(j=>j.id===id)?.status==='succeeded'),ids[1],{timeout:20000});assert.equal((await page.evaluate(()=>window.gis.snapshot())).jobs.find(j=>j.id===ids[0]).status,'cancelled')
 await page.getByRole('button',{name:'数据处理',exact:true}).click();await page.getByLabel('输入 TIFF / VRT 文件').fill(source);await page.getByRole('button',{name:'读取数据元信息'}).click();await page.getByText(/源分辨率建议最大 15 级/).waitFor();await page.getByLabel('最大层级').fill('18');await page.getByRole('button',{name:'使用建议',exact:true}).click();assert.equal(await page.getByLabel('最大层级').inputValue(),'15');
 console.log('安装包验收：实时进度条、耗时、两任务并发、第三个排队、取消隔离、源分辨率层级建议通过')
}finally{await app.close();await cleanupTestService(state);await rm(state,{recursive:true,force:true})}
