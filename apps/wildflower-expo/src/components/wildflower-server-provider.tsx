// oxlint-disable react-refresh/only-export-components

import { Effect, Layer, Scope } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { createContext, type JSX, type ReactNode, useContext, useRef, type RefObject } from 'react'
import { canonicalPublicOrigin } from 'tunnel-core/canonical-url'
import { TunnelState, TunnelStore } from 'tunnel-core/livestore'
import { PORT } from '../constants.ts'
import { httpServerDaemon, LOCAL_ORIGIN } from '../daemons/http-server.ts'
import { tunnelDaemon } from '../daemons/tunnel.ts'
import { useWildflowerStore, WildflowerStore } from '../livestore/livestore-store.ts'

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

interface WildflowerServerSnapshot {
  readonly running: boolean
  readonly localOrigin: string
  readonly port: number
  readonly currentPublicOrigin: string | null
  readonly requestedPublicOrigin: string | null
  readonly tunnelActive: boolean
}

interface WildflowerServerContextValue extends WildflowerServerSnapshot {
  /**
   * Commit a tunnel request (or clear it) and return a Promise that
   * resolves once `currentPublicOrigin` updates (or after a 15s
   * timeout, in which case it resolves with the local origin so
   * callers always have a usable URL to redirect to).
   */
  readonly setTunnelActive: (active: boolean) => Promise<string>
}

const WildflowerServerContext = createContext<WildflowerServerContextValue | null>(null)

const useWildflowerServerHandle = (): WildflowerServerContextValue => {
  const ctx = useContext(WildflowerServerContext)
  if (ctx === null) {
    throw new Error('useWildflowerServerHandle must be used within a <WildflowerServerProvider>')
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Daemon spawn (singleton — survives StrictMode mount/unmount)
// ---------------------------------------------------------------------------

interface DaemonHandle {
  readonly scope: Scope.CloseableScope
}

const spawnDaemons = (storeRef: RefObject<ReturnType<typeof useWildflowerStore>>): DaemonHandle => {
  const scope = Effect.runSync(Scope.make())

  // Read the store from the ref at fork time. Store identity changes
  // are extremely rare (the registry caches the store across remounts);
  // if one happens, a hard provider remount is acceptable for now.
  const store = storeRef.current

  Effect.runFork(
    httpServerDaemon().pipe(
      Effect.provide(Layer.succeed(WildflowerStore, store)),
      Scope.extend(scope)
    )
  )

  Effect.runFork(
    tunnelDaemon().pipe(
      Effect.provide(TunnelStore.layerFrom(store)),
      Effect.provide(LocalHttpServerStore.layerFrom(store)),
      Scope.extend(scope)
    )
  )

  return { scope }
}

const TUNNEL_AWAIT_TIMEOUT_MS = 15_000

/**
 * Commit a tunnel-state change and wait for the daemon to settle
 * `currentPublicOrigin`. Resolves with:
 *
 *   - `currentPublicOrigin` when set (success path),
 *   - the supplied `fallbackOrigin` when timing out or when `active`
 *     is `false` (no commit needed beyond the request clear).
 */
const commitAndAwait = (
  store: ReturnType<typeof useWildflowerStore>,
  active: boolean,
  fallbackOrigin: string
): Promise<string> =>
  new Promise<string>((resolve) => {
    store.commit(
      TunnelState.events.tunnelStateSet({
        requestedPublicOrigin: active ? canonicalPublicOrigin() : null,
      })
    )
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
      if (state.currentPublicOrigin !== null) finish(state.currentPublicOrigin)
    })
    const timer = setTimeout(() => finish(fallbackOrigin), TUNNEL_AWAIT_TIMEOUT_MS)
  })

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Thin React wrapper around the two on-device daemons (server +
 * tunnel). Both daemons coordinate exclusively through livestore client
 * documents — this provider just spawns them, reads their snapshots
 * from the store, and exposes `setTunnelActive` as a store commit +
 * await.
 *
 * Unmount intentionally does NOT close the daemon scope: a StrictMode
 * mount/unmount/remount would otherwise tear down a half-booted server.
 * The daemons live for the module's lifetime.
 */
function WildflowerServerProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const appStore = useWildflowerStore()
  const storeRef = useRef(appStore)
  storeRef.current = appStore

  const handleRef = useRef<DaemonHandle | null>(null)
  if (handleRef.current === null) {
    handleRef.current = spawnDaemons(storeRef)
  }

  const serverState = appStore.useQuery(ServerState.queries.current$)
  const tunnelState = appStore.useQuery(TunnelState.queries.current$)

  const snapshot: WildflowerServerSnapshot = {
    running: serverState.running,
    localOrigin: serverState.localOrigin ?? LOCAL_ORIGIN,
    port: serverState.port ?? PORT,
    currentPublicOrigin: tunnelState.currentPublicOrigin,
    requestedPublicOrigin: tunnelState.requestedPublicOrigin,
    tunnelActive: tunnelState.currentPublicOrigin !== null,
  }

  const setTunnelActive = (active: boolean): Promise<string> =>
    commitAndAwait(appStore, active, snapshot.localOrigin)

  return (
    <WildflowerServerContext.Provider value={{ ...snapshot, setTunnelActive }}>
      {children}
    </WildflowerServerContext.Provider>
  )
}

export { useWildflowerServerHandle, WildflowerServerProvider }
export type { WildflowerServerContextValue, WildflowerServerSnapshot }
