export interface LanPeer {
  id: string
  name: string
  ip: string
  port: number
  online: boolean
}
export interface LanMessage {
  id: string
  peerId: string
  direction: 'in' | 'out'
  text: string
  time: string
}
export interface LanTransfer {
  id: string
  peerId: string
  direction: 'in' | 'out'
  name: string
  files: number
  size: number
  received: number
  status: 'offered' | 'transferring' | 'done' | 'failed' | 'cancelled' | 'rejected'
  time: string
  path?: string
  error?: string
  speed?: number
}
export interface LanSnapshot {
  users?: { id: string; name: string; ips: string[] }[]
  self: { id: string; name: string; ips: string[] }
  peers: LanPeer[]
  messages: LanMessage[]
  transfers: LanTransfer[]
  error: string
}
