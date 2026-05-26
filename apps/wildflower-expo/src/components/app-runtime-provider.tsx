import { StoreRegistry, StoreRegistryProvider } from '@livestore/react'
import { Effect, Fiber, Layer } from 'effect'
import { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { type JSX, type PropsWithChildren, Suspense, useEffect, useState } from 'react'
import { Text } from 'react-native'
import { TunnelStore } from 'tunnel-core/livestore'
import { TunnelDaemon } from 'tunnel-expo'
import { HttpServerDaemonLive } from '../daemons/http-server.ts'
import { useWildflowerStore, WildflowerStore } from '../livestore/livestore-store.ts'

/**
 * Root runtime context for the on-device app shell: wires the
 * `@livestore/react` registry context (so `useWildflowerStore()`
 * downstream resolves to the shared module-singleton store) and
 * launches the on-device daemons (HTTP server + tunnel) under React's
 * mount lifecycle inside that registry context.
 */
export function AppRuntimeProvider({ children }: PropsWithChildren): JSX.Element {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <Suspense fallback={<Text>Loading…</Text>}>
      <StoreRegistryProvider storeRegistry={storeRegistry}>
        <DaemonRuntimeScope>{children}</DaemonRuntimeScope>
      </StoreRegistryProvider>
    </Suspense>
  )
}

/**
 * Ties the daemon launch's Effect Scope to this component's React
 * mount: `useEffect` `Effect.runFork`s `Layer.launch` on mount and
 * `Fiber.interrupt`s on cleanup.
 *
 * Lifecycle parity with `apps/wildflower-node/src/index.ts`: one
 * `Layer.launch` over `Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon)`,
 * one scope, one fiber. The wildflower store is provided once at the
 * outer layer; the tunnel slice gets its own projection.
 *
 * Implemented as a component (rather than a hook) because
 * `useWildflowerStore()` consumes the registry context provided one
 * level up by `<StoreRegistryProvider>` and suspends on the store
 * load — both have to be ancestors of the call site. The React
 * cleanup contract handles StrictMode's dev-only double-mount: the
 * first effect's cleanup interrupts the first fiber before the second
 * mount's effect runs, so we don't end up with two HTTP servers
 * racing the same port.
 *
 * The `[store]` dep relies on `useWildflowerStore()` returning a
 * stable reference from the `StoreRegistry` cache; if a future
 * refactor returns a fresh wrapper per render, each render would
 * tear down and relaunch the merged daemon Layer — i.e. churn the
 * on-device HTTP server and tunnel.
 */
function DaemonRuntimeScope({ children }: PropsWithChildren): JSX.Element {
  const store = useWildflowerStore()

  useEffect(() => {
    const fiber = Effect.runFork(
      Layer.launch(
        Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(WildflowerStore, store),
              TunnelStore.layerFrom(store),
              LocalHttpServerStore.layerFrom(store)
            )
          )
        )
      )
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [store])

  return <>{children}</>
}
