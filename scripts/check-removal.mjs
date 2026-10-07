import { _electron as electron } from 'playwright'
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'
const state=await mkdtemp(path.join(os.tmpdir(),'gis-removal-'));const directory=path.join(state,'data');await mkdir(directory);await writeFile(path.join(directory,'icon.svg'),'<svg/>')
const app=await electron.launch({executablePath:path.resolve('release/mac-arm64/GIS Data Press.app/Contents/MacOS/GIS Data Press'),env:{...process.env,GIS_PRESS_STATE:state}})
try{
 const page=await app.firstWindow();await page.getByRole('button',{name:'登记资源目录'}).first().waitFor();await page.evaluate(directory=>window.gis.savePublication({name:'确认验收',directory,mount:'/confirm/',kind:'image'}),directory)
 const remove=page.getByRole('button',{name:'移除 确认验收 的映射配置',exact:true});await remove.click();const dialog=page.getByRole('dialog',{name:'确认移除服务映射？'});await dialog.waitFor();assert.equal(await dialog.getByRole('button',{name:'取消',exact:true}).evaluate(el=>el===document.activeElement),true)
 assert.equal((await page.evaluate(()=>window.gis.snapshot())).publications.length,1);await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await page.evaluate(()=>window.gis.snapshot())).publications.length,1)
 await remove.click();await page.keyboard.press('Escape');assert.equal(await remove.evaluate(el=>el===document.activeElement),true)
 await remove.click();await dialog.getByRole('button',{name:'确认移除',exact:true}).click();await remove.waitFor({state:'detached'});assert.equal((await page.evaluate(()=>window.gis.snapshot())).publications.length,0);assert.equal(await readFile(path.join(directory,'icon.svg'),'utf8'),'<svg/>')
 console.log('移除前确认、取消、Escape、默认取消焦点、确认后仅移除配置：通过')
}finally{await app.close();await cleanupTestService(state);await rm(state,{recursive:true,force:true})}
