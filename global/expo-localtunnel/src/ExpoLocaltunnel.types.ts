type TunnelConnectionConfig = {
  remoteHost: string
  remotePort: number
  localHost: string
  localPort: number
  localHostHeader?: string
}

type ExpoLocaltunnelModuleEvents = {
  onConnectionOpen: (params: { connectionId: string }) => void
  onConnectionClose: (params: { connectionId: string }) => void
  onConnectionError: (params: { connectionId: string; error: string; code: string }) => void
  onConnectionDead: (params: { connectionId: string }) => void
  onRequest: (params: { connectionId: string; method: string; path: string }) => void
}

export type { TunnelConnectionConfig, ExpoLocaltunnelModuleEvents }
