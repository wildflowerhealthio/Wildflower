import type { TunnelState } from 'tunnel-react'

import type { AppEntry } from '../../../queries.ts'

/**
 * Where a launch click should send the browser, given the app and the live
 * tunnel state. Pure, so the origin policy is unit-tested without driving
 * `window.location`.
 *
 *  - `loopback` — a non-tunnel app: the embedded loopback origin.
 *  - `served` — a tunnel app while the tunnel is **verified** (the only status
 *    where `servedOrigin` is the public `https://{host}`); redirect straight to
 *    that origin.
 *  - `bridge` — a tunnel app in any other status (`off`/`misconfigured`, or
 *    `dialing`/`unreachable` where `servedOrigin` is still the loopback
 *    fallback): ask the host to bring the tunnel up and await its verified
 *    origin, rather than redirecting to loopback and silently bypassing the
 *    tunnel.
 */
type LaunchTarget =
  | { readonly via: 'loopback' }
  | { readonly via: 'served'; readonly origin: string }
  | { readonly via: 'bridge' }

const launchTarget = (app: AppEntry, tunnel: TunnelState): LaunchTarget => {
  if (!app.requiresTunnel) return { via: 'loopback' }
  if (tunnel.status === 'verified') return { via: 'served', origin: tunnel.servedOrigin }
  return { via: 'bridge' }
}

export { launchTarget }
export type { LaunchTarget }
