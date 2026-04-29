import { EventEmitter } from 'eventemitter3'

import TunnelCluster, { type TunnelClusterOpts } from './TunnelCluster.ts'

export interface TunnelOptions {
  port: number
  host?: string
  subdomain?: string
  local_host?: string
  local_https?: boolean
  local_cert?: string
  local_key?: string
  local_ca?: string
  allow_invalid_cert?: boolean
}

interface TunnelInfo extends TunnelClusterOpts {
  name: string
  url: string
  cached_url?: string
  max_conn: number
  local_https?: boolean
}

export default class Tunnel extends EventEmitter {
  opts: TunnelOptions
  closed = false
  url?: string
  cachedUrl?: string
  clientId?: string

  private tunnelCluster?: TunnelCluster

  constructor(opts: TunnelOptions) {
    super()
    this.opts = opts
    if (!this.opts.host) {
      this.opts.host = 'https://localtunnel.me'
    }
  }

  private _getInfo(body: {
    id: string
    ip?: string
    port: number
    url: string
    cached_url?: string
    max_conn_count?: number
  }): TunnelInfo {
    const { id, ip, port, url, cached_url, max_conn_count } = body
    const { host, port: local_port, local_host, local_https } = this.opts
    return {
      name: id,
      url,
      cached_url,
      max_conn: max_conn_count || 1,
      remote_host: new URL(host!).hostname,
      remote_ip: ip,
      remote_port: port,
      local_port,
      local_host,
      local_https,
    }
  }

  private _init(cb: (err: Error | null, info?: TunnelInfo) => void): void {
    const opt = this.opts
    const getInfo = this._getInfo.bind(this)

    const baseUri = `${opt.host}/`
    const assignedDomain = opt.subdomain
    const uri = baseUri + (assignedDomain || '?new')

    ;(function getUrl() {
      fetch(uri)
        .then((res) => {
          if (!res.ok) {
            return res.text().then((text) => {
              throw new Error(text || 'localtunnel server returned an error, please try again')
            })
          }
          return res.json()
        })
        .then((body) => {
          cb(null, getInfo(body))
        })
        .catch(() => {
          setTimeout(getUrl, 1000)
        })
    })()
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

    let _tunnelCount = 0

    // track open count
    this.tunnelCluster.on('open', () => {
      _tunnelCount++
      if (this.closed) {
        return
      }
    })

    // when a tunnel dies, open a new one
    this.tunnelCluster.on('dead', () => {
      _tunnelCount--
      if (this.closed) {
        return
      }
      this.tunnelCluster!.open()
    })

    this.tunnelCluster.on('request', (req: { method: string; path: string }) => {
      this.emit('request', req)
    })

    // establish as many tunnels as allowed
    for (let count = 0; count < info.max_conn; ++count) {
      this.tunnelCluster.open()
    }
  }

  open(cb: (err?: Error | null) => void): void {
    this._init((err, info) => {
      if (err) {
        return cb(err)
      }

      if (info!.local_https) {
        return cb(
          new Error(
            'local_https is not supported in expo-localtunnel. Only plaintext HTTP to the local server is supported.'
          )
        )
      }

      this.clientId = info!.name
      this.url = info!.url

      // `cached_url` is only returned by proxy servers that support resource caching.
      if (info!.cached_url) {
        this.cachedUrl = info!.cached_url
      }

      this._establish(info!)
      cb()
    })
  }

  close(): void {
    this.closed = true
    if (this.tunnelCluster) {
      this.tunnelCluster.close()
    }
    this.emit('close')
  }
}
