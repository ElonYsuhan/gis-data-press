import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/contracts'
const api:DesktopAPI={
 resources:()=>ipcRenderer.invoke('gis:resources'),searchBoundaries:q=>ipcRenderer.invoke('gis:searchBoundaries',q),downloadResource:r=>ipcRenderer.invoke('gis:downloadResource',r),registerResource:(k,p)=>ipcRenderer.invoke('gis:registerResource',k,p),cancelDownload:id=>ipcRenderer.invoke('gis:cancelDownload',id),forgetResource:id=>ipcRenderer.invoke('gis:forgetResource',id),
 openBrowser:()=>ipcRenderer.invoke('gis:openBrowser'),
 snapshot:()=>ipcRenderer.invoke('gis:snapshot'),choose:mode=>ipcRenderer.invoke('gis:choose',mode),inspect:path=>ipcRenderer.invoke('gis:inspect',path),
 savePublication:value=>ipcRenderer.invoke('gis:savePublication',value),togglePublication:id=>ipcRenderer.invoke('gis:togglePublication',id),removePublication:id=>ipcRenderer.invoke('gis:removePublication',id),refresh:()=>ipcRenderer.invoke('gis:refresh'),saveSettings:value=>ipcRenderer.invoke('gis:saveSettings',value),server:action=>ipcRenderer.invoke('gis:server',action),submit:value=>ipcRenderer.invoke('gis:submit',value),cancel:id=>ipcRenderer.invoke('gis:cancel',id),reveal:path=>ipcRenderer.invoke('gis:reveal',path),copy:text=>ipcRenderer.invoke('gis:copy',text)
}
contextBridge.exposeInMainWorld('gis',api)
