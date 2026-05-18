import { EventEmitter } from 'eventemitter3'

import type { TunnelConnectionConfig } from './ExpoLocaltunnel.types.ts'
import NativeModule from './ExpoLocaltunnelModule.ts'

// Connection IDs identify in-flight tunnel connections within a single app
// session. They don't cross processes or persist, so cryptographic randomness
// isn't required — `Date.now()` + a monotonic counter + `Math.random()` is
// sufficient and avoids depending on `expo-crypto` (whose eager
// `requireNativeModule('ExpoCrypto')` throws at module-load time on platforms
// where the native module wasn't autolinked, blanking the whole app).
let connectionIdCounter = 0
function generateConnectionId(): string {
  connectionIdCounter += 1
  const ts = Date.now().toString(36)
  const counter = connectionIdCounter.toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `${ts}-${counter}-${rand}`
}

export interface TunnelClusterOpts {
  remoteHost: string
  remoteIp?: string
  remotePort: number
  localHost?: string
  localPort: number
}

// Manages groups of tunnel connections via the native module.
export default class TunnelCluster extends EventEmitter {
  private opts: TunnelClusterOpts
  private connections = new Set<string>()
  private subscriptions: { remove(): void }[] = []

  constructor(opts: TunnelClusterOpts) {
    super()
    this.opts = opts
    // Flush any orphaned native connections from a previous JS reload
    NativeModule.closeAllTunnelConnections().catch(() => {})
    this.setupNativeListeners()
  }

  private setupNativeListeners(): void {
    this.subscriptions.push(
      NativeModule.addListener('onConnectionOpen', ({ connectionId }) => {
        if (!this.connections.has(connectionId)) return
        this.emit('open')
      }),
      NativeModule.addListener('onConnectionClose', ({ connectionId }) => {
        if (!this.connections.has(connectionId)) return
        this.connections.delete(connectionId)
        this.emit('dead')
      }),
      NativeModule.addListener('onConnectionError', ({ connectionId, error, code }) => {
        if (!this.connections.has(connectionId)) return
        this.connections.delete(connectionId)
        // Pass the native error text through verbatim — it carries a `remote:` /
        // `local:` prefix that tells the caller which leg of the tunnel failed.
        // Don't synthesize a message from `remoteHost:remotePort`; that hides
        // local-side failures behind a misleading "connection refused: localtunnel.me"
        // string.
        const message = `tunnel error (${code}): ${error}`
        this.emit('error', Object.assign(new Error(message), { code }))
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
    const connectionId = generateConnectionId()
    this.connections.add(connectionId)

    const config: TunnelConnectionConfig = {
      remoteHost: this.opts.remoteIp || this.opts.remoteHost,
      remotePort: this.opts.remotePort,
      localHost: this.opts.localHost || 'localhost',
      localPort: this.opts.localPort,
      localHostHeader: this.opts.localHost || undefined,
    }

    NativeModule.createTunnelConnection(connectionId, config).catch((err: Error) => {
      this.connections.delete(connectionId)
      this.emit('error', err)
    })
  }

  close(): void {
    for (const sub of this.subscriptions) {
      sub.remove()
    }
    this.subscriptions = []
    this.connections.clear()
    NativeModule.closeAllTunnelConnections().catch(() => {})
  }
}
