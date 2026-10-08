import type { DesktopAPI } from '../../shared/contracts'
const token = location.hash.slice(1) || sessionStorage.getItem('gis-management-token') || ''
if (!window.gis && token) {
  sessionStorage.setItem('gis-management-token', token)
}
if (!window.gis) {
  history.replaceState(null, '', location.pathname)
}
const remote = new Proxy({} as DesktopAPI, {
  get:
    (_target, name: string) =>
    async (...args: unknown[]) => {
      if (name === 'copy') {
        await navigator.clipboard.writeText(String(args[0]))
        return
      }
      if (name === 'openBrowser') {
        return
      }
      const response = await fetch(`/api/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
      })
      const value = await response.json()
      if (!response.ok) {
        throw new Error(value.error ?? '管理请求失败')
      }
      return value.result
    },
})
export const api: DesktopAPI = window.gis ?? remote
export const desktop = !!window.gis
