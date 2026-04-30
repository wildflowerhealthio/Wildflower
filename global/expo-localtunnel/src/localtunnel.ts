import Tunnel, { type TunnelOptions } from './Tunnel.ts'

type Callback = (err: Error | null, tunnel?: Tunnel) => void

/**
 * Open a localtunnel using an options object. Returns a Promise that resolves to the
 * connected `Tunnel`, or rejects on failure.
 */
export default function localtunnel(opts: TunnelOptions): Promise<Tunnel>
/**
 * Open a localtunnel using an options object. Invokes `callback` once the tunnel is
 * connected (or with an error). Returns the `Tunnel` instance synchronously so callers
 * can attach listeners before connection completes.
 */
export default function localtunnel(opts: TunnelOptions, callback: Callback): Tunnel
/**
 * Open a localtunnel for the given local `port`. Returns a Promise that resolves to the
 * connected `Tunnel`, or rejects on failure.
 */
export default function localtunnel(
  port: number,
  opts?: Omit<TunnelOptions, 'port'>,
  callback?: undefined
): Promise<Tunnel>
/**
 * Open a localtunnel for the given local `port`. Invokes `callback` once the tunnel is
 * connected (or with an error). Returns the `Tunnel` instance synchronously so callers
 * can attach listeners before connection completes.
 */
export default function localtunnel(
  port: number,
  opts: Omit<TunnelOptions, 'port'> | undefined,
  callback: Callback
): Tunnel

export default function localtunnel(
  arg1: TunnelOptions | number,
  arg2?: Omit<TunnelOptions, 'port'> | Callback,
  arg3?: Callback
): Tunnel | Promise<Tunnel> {
  let options: TunnelOptions
  let callback: Callback | undefined
  if (typeof arg1 === 'object') {
    options = arg1
    if (typeof arg2 === 'function') {
      callback = arg2
    }
  } else {
    let rest: Omit<TunnelOptions, 'port'> = {}
    if (arg2 !== undefined && typeof arg2 !== 'function') {
      rest = arg2
    }
    options = { ...rest, port: arg1 }
    callback = arg3
  }

  const client = new Tunnel(options)

  if (callback) {
    const cb = callback
    client.open((err) => {
      if (err) {
        cb(err)
      } else {
        cb(null, client)
      }
    })
    return client
  }

  return new Promise((resolve, reject) => {
    client.open((err) => {
      if (err) {
        reject(err)
      } else {
        resolve(client)
      }
    })
  })
}
