import { EventEmitter } from 'eventemitter3'

import TunnelCluster, { type TunnelClusterOpts } from './TunnelCluster.ts'

export interface TunnelOptions {
  port: number
  host?: string
  subdomain?: string
  localHost?: string
  localHttps?: boolean
  localCert?: string
  localKey?: string
  localCa?: string
  allowInvalidCert?: boolean
}

interface TunnelInfo extends TunnelClusterOpts {
  name: string
  url: string
  cachedUrl?: string
  maxConn: number
  localHttps?: boolean
}

interface AssignResponseBody {
  id: string
  ip?: string
  port: number
  url: string
  cached_url?: string
  max_conn_count?: number
}

// Exponential backoff schedule (ms): 1s, 2s, 4s, 8s, 16s — total ~31s before failing.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const

const toError = (err: unknown): Error => {
  if (err instanceof Error) return err
  return new Error(String(err))
}

const isAssignResponseBody = (value: unknown): value is AssignResponseBody => {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || typeof value.id !== 'string') return false
  if (!('port' in value) || typeof value.port !== 'number') return false
  if (!('url' in value) || typeof value.url !== 'string') return false
  return true
}

export default class Tunnel extends EventEmitter {
  opts: TunnelOptions
  closed = false
  url?: string
  cachedUrl?: string
  clientId?: string

  private tunnelCluster?: TunnelCluster
  private initController?: AbortController

  constructor(opts: TunnelOptions) {
    super()
    this.opts = opts
    if (!this.opts.host) {
      this.opts.host = 'https://localtunnel.me'
    }
  }

  private _getInfo(body: AssignResponseBody): TunnelInfo {
    const { id, ip, port, url, cached_url, max_conn_count } = body
    const { host, port: localPort, localHost, localHttps } = this.opts
    return {
      name: id,
      url,
      cachedUrl: cached_url,
      maxConn: max_conn_count ?? 1,
      remoteHost: new URL(host!).hostname,
      remoteIp: ip,
      remotePort: port,
      localPort,
      localHost,
      localHttps,
    }
  }

  private _init(cb: (err: Error | null, info?: TunnelInfo) => void): void {
    const opt = this.opts
    const baseUri = `${opt.host}/`
    const assignedDomain = opt.subdomain
    const uri = baseUri + (assignedDomain || '?new')

    const controller = new AbortController()
    this.initController = controller

    let settled = false
    const settle = (err: Error | null, info?: TunnelInfo): void => {
      if (settled) return
      settled = true
      cb(err, info)
    }

    // If `close()` aborts mid-init, reject the open callback so callers
    // awaiting the Promise see a predictable rejection rather than hanging.
    controller.signal.addEventListener(
      'abort',
      () => {
        settle(new Error('tunnel closed before connection established'))
      },
      { once: true }
    )

    const fetchOnce = (): Promise<TunnelInfo> =>
      fetch(uri, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) {
            return res.text().then((text) => {
              throw new Error(text || 'localtunnel server returned an error, please try again')
            })
          }
          return res.json()
        })
        .then((body: unknown) => {
          if (!isAssignResponseBody(body)) {
            throw new Error('localtunnel server returned an unexpected response shape')
          }
          return this._getInfo(body)
        })

    // Wait `delay` ms; resolve `true` if aborted before the delay elapses.
    const wait = (delay: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort)
          resolve(false)
        }, delay)
        const onAbort = (): void => {
          clearTimeout(timer)
          resolve(true)
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })

    const attempt = (i: number): void => {
      if (settled) return

      void fetchOnce().then(
        (info) => {
          settle(null, info)
        },
        (err: unknown) => {
          if (settled) return
          const nextError = toError(err)
          const delay = RETRY_DELAYS_MS[i]
          if (delay === undefined) {
            settle(
              new Error(
                `failed to reach localtunnel server after ${RETRY_DELAYS_MS.length + 1} attempts: ${nextError.message}`
              )
            )
            return
          }
          void wait(delay).then((cancelled) => {
            if (settled || cancelled) return
            attempt(i + 1)
          })
        }
      )
    }

    attempt(0)
  }

  private _establish(info: TunnelInfo): void {
    this.tunnelCluster = new TunnelCluster(info)

    // only emit the url the first time
    this.tunnelCluster.once('open', () => {
      this.emit('url', info.url)
    })

    // re-emit socket error
    this.tunnelCluster.on('error', (err: Error) => {
      this.emit('error', err)
    })

    // when a tunnel dies, open a new one
    this.tunnelCluster.on('dead', () => {
      if (this.closed) {
        return
      }
      this.tunnelCluster!.open()
    })

    this.tunnelCluster.on('request', (req: { method: string; path: string }) => {
      this.emit('request', req)
    })

    // establish as many tunnels as allowed
    for (let count = 0; count < info.maxConn; ++count) {
      this.tunnelCluster.open()
    }
  }

  open(cb: (err?: Error | null) => void): void {
    this._init((err, info) => {
      if (err) {
        return cb(err)
      }

      if (info!.localHttps) {
        return cb(
          new Error(
            'localHttps is not supported in expo-localtunnel. Only plaintext HTTP to the local server is supported.'
          )
        )
      }

      this.clientId = info!.name
      this.url = info!.url

      // `cachedUrl` is only returned by proxy servers that support resource caching.
      if (info!.cachedUrl) {
        this.cachedUrl = info!.cachedUrl
      }

      this._establish(info!)
      cb()
    })
  }

  close(): void {
    this.closed = true
    if (this.initController) {
      this.initController.abort()
    }
    if (this.tunnelCluster) {
      this.tunnelCluster.close()
    }
    this.emit('close')
  }
}
