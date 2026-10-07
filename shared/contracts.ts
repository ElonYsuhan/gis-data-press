export type ServiceKind = 'imagery' | 'terrain' | 'tileset' | 'model' | 'image'
export type JobKind = 'imagery' | 'terrain' | 'osgb'
export interface Resource { path: string; size: number; modified: string }
export interface Publication {
  id: string; name: string; directory: string; mount: string; kind: ServiceKind; enabled: boolean
  valid: boolean; reason: string; count: number; indexed: Resource[]; indexedAt: string; bounds?: number[]; minZoom?: number; maxZoom?: number
}
export interface Settings { port: number; host: '127.0.0.1' | '0.0.0.0'; nginx: string; python: string; gdal: string; terrain: string; osgb: string; cacheSeconds: number; taskConcurrency: number; workerBudget: number }
export interface Engine { id: string; label: string; path: string; available: boolean; detail: string }
export interface Inspection { path: string; type: string; size?: number; width?: number; height?: number; bands?: number; crs?: string; bounds?: number[]; nodata?: number | null; dtype?: string; units?: string; files?: number; warnings: string[]; pixelSize?: number[]; recommendedZoom?: { imagery:number; terrain:number } }
export interface JobRequest { kind: JobKind; input: string; output: string; minZoom: number; maxZoom: number; workers: number; sourceCrs: string; scale: boolean; longitude?: number; latitude?: number; verticalDatum: 'ellipsoid' | 'unknown' }
export interface Job { id: string; request: JobRequest; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; stage: string; logs: string[]; createdAt: string; finishedAt?: string; startedAt?: string; effectiveWorkers?: number; progress?: { percent:number; label?:string }; error?: string }
export interface Snapshot { publications: Publication[]; jobs: Job[]; settings: Settings; engines: Engine[]; server: { running: boolean; error: string; addresses: string[] }; logs: string[] }
export interface DesktopAPI {
  resources(): Promise<LocalAsset[]>
  searchBoundaries(query:string): Promise<BoundaryResult[]>
  downloadResource(request:DownloadRequest): Promise<string>
  registerResource(kind:AssetKind,path:string): Promise<string>
  cancelDownload(id:string): Promise<void>
  forgetResource(id:string): Promise<void>
  openBrowser(): Promise<void>
  snapshot(): Promise<Snapshot>
  choose(mode: 'file' | 'directory' | 'executable'): Promise<string | null>
  inspect(path: string): Promise<Inspection>
  savePublication(value: Pick<Publication,'name'|'directory'|'mount'|'kind'> & { id?: string }): Promise<void>
  togglePublication(id: string): Promise<void>
  removePublication(id: string): Promise<void>
  refresh(): Promise<void>
  saveSettings(settings: Settings): Promise<void>
  server(action: 'start' | 'stop'): Promise<void>
  submit(request: JobRequest): Promise<string>
  cancel(id: string): Promise<void>
  reveal(path: string): Promise<void>
  copy(text: string): Promise<void>
}
export const kindLabels: Record<ServiceKind, string> = {imagery:'影像瓦片',terrain:'高程地形',tileset:'三维场景',model:'模型文件',image:'图片 / 图标'}

export type AssetKind = 'imagery' | 'terrain' | 'boundary' | 'tileset' | 'image' | 'model'
export interface BoundaryResult { adcode:number; name:string; level:string; ancestors:string }
export interface LocalAsset { id:string; kind:AssetKind; name:string; path:string; url?:string; received:number; size:number; status:'downloading'|'ready'|'failed'|'cancelled'; error?:string; exists?:boolean; isDirectory?:boolean; createdAt:string }
export interface DownloadRequest { kind:AssetKind; directory:string; url:string; filename:string; adcode?:number; children?:boolean }
