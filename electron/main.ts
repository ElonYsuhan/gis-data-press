import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell, Menu } from 'electron'
import path from 'node:path'
import { startBrowserUI } from './browser'
import type { Manager } from './manager'
import { connectService } from './service-client'

process.env.PATH=[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin'].filter(Boolean).join(path.delimiter)
let browserUI:Awaited<ReturnType<typeof startBrowserUI>>|undefined;let manager:Manager;let window:BrowserWindow;let quitting=false
if(!app.requestSingleInstanceLock())app.quit()
else {
app.on('second-instance',()=>{if(!quitting&&window&&!window.isDestroyed()){window.show();window.focus()}})
app.whenReady().then(async()=>{
 const project=app.getAppPath();const resources=app.isPackaged?process.resourcesPath:project
 manager=await connectService(process.env.GIS_PRESS_STATE??app.getPath('userData'),project,resources)
 window=new BrowserWindow({width:1440,height:940,minWidth:1080,minHeight:720,title:'GIS Data Press',icon:path.join(project,'dist','app-icon.png'),backgroundColor:'#f5f7fa',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}})
 const methods:Record<string,(...args:any[])=>any>={resources:(...a:any[])=>manager.listResources(),searchBoundaries:(...a:any[])=>manager.searchBoundaries(a[0]),downloadResource:(...a:any[])=>manager.downloadResource(a[0]),registerResource:(...a:any[])=>manager.registerResource(a[0], a[1]),cancelDownload:(...a:any[])=>manager.cancelDownload(a[0]),forgetResource:(...a:any[])=>manager.forgetResource(a[0]),snapshot:()=>manager.snapshot(),inspect:p=>manager.inspect(p),savePublication:p=>manager.savePublication(p),togglePublication:id=>manager.togglePublication(id),removePublication:id=>manager.removePublication(id),refresh:()=>manager.refresh(),saveSettings:s=>manager.saveSettings(s),server:a=>manager.server(a),submit:r=>manager.submit(r),cancel:id=>manager.cancel(id),
 choose:async(mode:string)=>{if(!['file','directory','executable'].includes(mode))throw new Error('选择类型无效');const result=await dialog.showOpenDialog(window,{title:mode==='directory'?'选择资源目录':'选择本地文件',properties:mode==='directory'?['openDirectory','createDirectory']:['openFile']});return result.canceled?null:result.filePaths[0]},
 reveal:async(p:string)=>{if(typeof p!=='string'||!path.isAbsolute(p))throw new Error('路径无效');const error=await shell.openPath(p);if(error)throw new Error(error)},copy:(text:string)=>{if(typeof text!=='string'||text.length>100000)throw new Error('文本无效');clipboard.writeText(text)}}
 browserUI=await startBrowserUI(path.join(project,'dist'),methods)
 methods.openBrowser=()=>shell.openExternal(browserUI!.url)
 for(const [name,handler] of Object.entries(methods))ipcMain.handle('gis:'+name,(event,...args)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('未授权调用');return handler(...args)})
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}))
 window.webContents.on('will-navigate',(event,url)=>{if(url!==window.webContents.getURL())event.preventDefault()})
 window.on('close',event=>{if(!quitting){event.preventDefault();app.quit()}})
 if(process.platform==='darwin')app.dock?.setIcon(nativeImage.createFromPath(path.join(project,'dist','app-icon.png')))
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'GIS Data Press',submenu:[{label:'显示窗口',click:()=>window.show()},{role:'quit',label:'退出管理界面'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'视图',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]))
 if(process.env.GIS_DEV_URL)await window.loadURL(process.env.GIS_DEV_URL);else await window.loadURL(browserUI.url)
}).catch(error=>{dialog.showErrorBox('启动失败',String(error));app.quit()})
app.on('activate',()=>{if(!quitting&&window&&!window.isDestroyed())window.show()})
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void Promise.allSettled([browserUI?.close(),manager?.close()]).then(()=>app.quit())})
}
