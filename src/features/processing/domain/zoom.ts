export type TiledKind = 'imagery' | 'terrain'
const IMAGERY_BASE = 156543.03392804097
const TERRAIN_BASE = 313086.06785608194
export function metresAtZoom(kind: TiledKind, zoom: number, latitude = 0): number {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 85) {
    throw new Error('纬度应在 −85° 到 85° 之间')
  }
  return (
    (kind === 'imagery' ? IMAGERY_BASE * Math.cos((latitude * Math.PI) / 180) : TERRAIN_BASE) /
    2 ** zoom
  )
}
export function zoomForMetres(kind: TiledKind, metres: number, latitude = 0): number {
  if (!Number.isFinite(metres) || metres <= 0) {
    throw new Error('分辨率必须大于 0')
  }
  const raw = Math.log2(metresAtZoom(kind, 0, latitude) / metres)
  return Math.max(0, Math.ceil(raw - 1e-10))
}
