import type { Store } from '@livestore/livestore'
import { TunnelConfig, TunnelState } from 'tunnel-core/livestore'
import type { schema } from '../livestore/schema.ts'

const TUNNEL_AWAIT_TIMEOUT_MS = 15_000

/**
 * Flip `TunnelConfig.requestedRunning` and wait for the tunnel daemon
 * to settle `TunnelState`.
 *
 * The host-level `TunnelDaemon` (forked once at app boot) is what
 * actually opens / tears down the tunnel; this helper only writes the
 * intent and observes the daemon's response.
 *
 *  - `active === true`: commit `requestedRunning: true`. Resolves with
 *    `https://{currentSubdomain}.{currentRootDomain}` once
 *    `TunnelState.running` flips true; falls back to `fallbackOrigin`
 *    if either domain field is still null when running flips, or after
 *    the 15s timeout.
 *  - `active === false`: commit `requestedRunning: false` and resolve
 *    `fallbackOrigin` immediately — the daemon will tear the tunnel
 *    down on its own schedule, but callers don't wait for it.
 *
 * Canonical `subdomain` / `rootDomain` / `localPort` were seeded into
 * `TunnelConfig` at first boot (see `livestore-store.ts`); we only
 * write `requestedRunning` here so user-customised values persist.
 */
const commitAndAwaitTunnel = (
  store: Store<typeof schema, object>,
  active: boolean,
  fallbackOrigin: string,
  timeoutMs: number = TUNNEL_AWAIT_TIMEOUT_MS
): Promise<string> =>
  new Promise<string>((resolve) => {
    store.commit(TunnelConfig.events.tunnelConfigSet({ requestedRunning: active }))
    if (!active) {
      resolve(fallbackOrigin)
      return
    }
    let settled = false
    let unsubscribe: (() => void) | null = null
    const finish = (origin: string): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
      clearTimeout(timer)
      resolve(origin)
    }
    unsubscribe = store.subscribe(TunnelState.queries.current$, (state) => {
      if (!state.running) return
      if (state.currentSubdomain !== null && state.currentRootDomain !== null) {
        finish(`https://${state.currentSubdomain}.${state.currentRootDomain}`)
      }
    })
    const timer = setTimeout(() => finish(fallbackOrigin), timeoutMs)
  })

export { commitAndAwaitTunnel }
