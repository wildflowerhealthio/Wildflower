import { EventEmitter } from 'eventemitter3'

import type { TunnelConnectionConfig } from './ExpoLocaltunnel.types.ts'
import NativeModule from './ExpoLocaltunnelModule.ts'

export interface TunnelClusterOpts {
  remote_host: string
  remote_ip?: string
  remote_port: number
  local_host?: string
  local_port: number
}

let nextId = 0
function genId(): string {
  return `conn_${++nextId}_${Date.now()}`
}

// Manages groups of tunnel connections via the native module.
export default class TunnelCluster extends EventEmitter {
  private opts: TunnelClusterOpts
  private connections = new Map<string, boolean>()
  private _subscriptions: { remove(): void }[] = []

  constructor(opts: TunnelClusterOpts) {
    super()
    this.opts = opts
    // Flush any orphaned native connections from a previous JS reload
    NativeModule.closeAllTunnelConnections().catch(() => {})
    this._setupNativeListeners()
  }

  private _setupNativeListeners(): void {
    this._subscriptions.push(
      NativeModule.addListener('onConnectionOpen', ({ connectionId }) => {
        if (!this.connections.has(connectionId)) return
        this.emit('open')
      }),
      NativeModule.addListener('onConnectionClose', ({ connectionId }) => {
        if (!this.connections.has(connectionId)) return
        this.connections.delete(connectionId)
        this.emit('dead')
      }),
      NativeModule.addListener('onConnectionError', ({ connectionId, code }) => {
        if (!this.connections.has(connectionId)) return
        this.connections.delete(connectionId)
        if (code === 'ECONNREFUSED') {
          this.emit(
            'error',
            new Error(
              `connection refused: ${this.opts.remote_host}:${this.opts.remote_port} (check your firewall settings)`
            )
          )
        }
        this.emit('dead')
      }),
      NativeModule.addListener('onConnectionDead', ({ connectionId }) => {
        if (!this.connections.has(connectionId)) return
        this.connections.delete(connectionId)
        this.emit('dead')
      }),
      NativeModule.addListener('onRequest', ({ connectionId, method, path }) => {
        if (!this.connections.has(connectionId)) return
        this.emit('request', { method, path })
      })
    )
  }

  open(): void {
    const connectionId = genId()
    this.connections.set(connectionId, true)

    const config: TunnelConnectionConfig = {
      remoteHost: this.opts.remote_ip || this.opts.remote_host,
      remotePort: this.opts.remote_port,
      localHost: this.opts.local_host || 'localhost',
      localPort: this.opts.local_port,
      localHostHeader: this.opts.local_host || undefined,
    }

    NativeModule.createTunnelConnection(connectionId, config).catch((err: Error) => {
      this.connections.delete(connectionId)
      this.emit('error', err)
    })
  }

  close(): void {
    for (const sub of this._subscriptions) {
      sub.remove()
    }
    this._subscriptions = []
    this.connections.clear()
    NativeModule.closeAllTunnelConnections().catch(() => {})
  }
}
