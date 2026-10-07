import type { DesktopAPI } from '../shared/contracts'
declare global { interface Window { gis: DesktopAPI; CESIUM_BASE_URL: string } }
export {}
