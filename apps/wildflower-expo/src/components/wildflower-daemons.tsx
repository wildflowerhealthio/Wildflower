import { Effect, Layer, Scope } from 'effect'
import { useRef, type JSX } from 'react'
import { TunnelStore } from 'tunnel-core/livestore'
import { TunnelDaemon } from 'tunnel-expo'
import { httpServerDaemon } from '../daemons/http-server.ts'
import { useWildflowerStore, WildflowerStore } from '../livestore/livestore-store.ts'

/**
 * Spawn the two on-device daemons (HTTP server + tunnel) once at app
 * boot, both forked under a single shared Scope.
 *
 * - The HTTP-server daemon (`httpServerDaemon`) watches
 *   `LocalHttpServerState.requestedRunning` and forks
 *   `WildflowerServerLive` into a sub-scope when set.
 * - The tunnel daemon (`TunnelDaemon` from `tunnel-expo`) watches
 *   `TunnelConfig.requestedRunning` and forks `startTunnel` into a
 *   sub-scope when set.
 *
 * Both daemons live for the module's lifetime regardless of React
 * StrictMode mount/unmount/remount, so a transient remount can't tear
 * down a half-booted server. Consumers read the daemons' livestore-
 * surfaced state via `useQuery` directly — there's no React Context
 * indirection here.
 */
function WildflowerDaemons(): JSX.Element | null {
  const store = useWildflowerStore()
  const spawnedRef = useRef(false)
  if (!spawnedRef.current) {
    spawnedRef.current = true
    const scope = Effect.runSync(Scope.make())
    Effect.runFork(
      httpServerDaemon().pipe(
        Effect.provide(Layer.succeed(WildflowerStore, store)),
        Scope.extend(scope)
      )
    )
    Effect.runFork(
      Layer.launch(TunnelDaemon.pipe(Layer.provide(TunnelStore.layerFrom(store)))).pipe(
        Scope.extend(scope)
      )
    )
  }
  return null
}

export { WildflowerDaemons }
