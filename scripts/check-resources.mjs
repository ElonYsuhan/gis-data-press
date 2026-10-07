import { _electron as electron } from 'playwright'
import { mkdtemp,mkdir,readFile,rm,unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'
const state=await mkdtemp(path.join(os.tmpdir(),'gis-resources-'));const directory=path.join(state,'downloads');await mkdir(directory)
const app=await electron.launch({executablePath:path.resolve('release/mac-arm64/GIS Data Press.app/Contents/MacOS/GIS Data Press'),args:['--user-data-dir='+path.join(state,'desktop')],env:{...process.env,GIS_PRESS_STATE:state}})
try{
 const page=await app.firstWindow();await page.getByRole('button',{name:'资源下载',exact:true}).click();await page.getByRole('textbox',{name:'地名或行政区代码'}).fill('西安');await page.getByRole('button',{name:'检索',exact:true}).click();await page.getByRole('button',{name:/西安市.*610100/}).waitFor({timeout:30000});await page.getByRole('button',{name:/西安市.*610100/}).click();await page.getByRole('checkbox',{name:'下载下一级行政区边界集合'}).check();await page.getByRole('textbox',{name:'下载到本地目录'}).fill(directory);await page.getByRole('button',{name:'下载到本地',exact:true}).click();await page.getByText('本地可用',{exact:true}).waitFor({timeout:30000});const file=path.join(directory,'西安市-610100-下级边界.geojson');const json=JSON.parse(await readFile(file,'utf8'));assert.equal(json.type,'FeatureCollection');assert.equal(json.features.length,13)
 await page.getByRole('button',{name:'下载到本地',exact:true}).click();await page.getByRole('alert').filter({hasText:'同名文件'}).waitFor();assert.equal(JSON.parse(await readFile(file,'utf8')).features.length,13)
 await page.getByRole('button',{name:'关闭错误',exact:true}).click();await page.setViewportSize({width:1080,height:720});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:1440,height:940});await mkdir('output/playwright',{recursive:true});await page.screenshot({path:'output/playwright/resources-download.png'})
 await unlink(file);await page.getByRole('button',{name:'检查',exact:true}).click();await page.getByText('文件已失效',{exact:true}).waitFor();await page.getByRole('button',{name:'移除索引',exact:true}).click();const dialog=page.getByRole('dialog',{name:'确认移除资源索引？'});await dialog.waitFor();await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await page.evaluate(()=>window.gis.resources())).length,1)
 console.log('资源页面：真实 DataV 检索、13 区县 GeoJSON 下载、同名保护、失效检查、移除确认、窄窗口布局通过')
}finally{await app.close();await cleanupTestService(state);await rm(state,{recursive:true,force:true})}
