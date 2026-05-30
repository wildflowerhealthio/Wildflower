import { StoreRegistry, StoreRegistryProvider } from '@livestore/react'
import { Effect, Layer } from 'effect'
import { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { type JSX, type PropsWithChildren, Suspense, useMemo, useState } from 'react'
import { useComponentScopedRunner } from 'react-kitchen-sink'
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
export default function AppRuntimeProvider({ children }: PropsWithChildren): JSX.Element {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <Suspense fallback={<Text>Loading AppRuntimeProvider …</Text>}>
      <StoreRegistryProvider storeRegistry={storeRegistry}>
        <DaemonRuntimeScope>{children}</DaemonRuntimeScope>
      </StoreRegistryProvider>
    </Suspense>
  )
}

/**
 * Ties the daemon launch's Effect Scope to this component's React
 * mount via {@link useComponentScopedRunner}. Lifecycle parity with
 * `apps/wildflower-node/src/index.ts`: one `Layer.launch` over
 * `Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon)`, one scope,
 * one fiber. The wildflower store is provided once at the outer
 * layer; the tunnel slice gets its own projection.
 *
 * Component, not hook — `useWildflowerStore()` consumes the registry
 * context provided one level up by `<StoreRegistryProvider>` and
 * suspends on the store load.
 */
function DaemonRuntimeScope({ children }: PropsWithChildren): JSX.Element {
  const store = useWildflowerStore()

  const daemons = useMemo(
    () =>
      Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(WildflowerStore, store),
            TunnelStore.layerFrom(store),
            LocalHttpServerStore.layerFrom(store)
          )
        ),
        Layer.launch,
        Effect.onError((cause) => Effect.logError('HTTP + Tunnel Daemon failed', cause)),
        Effect.orDie
      ),
    [store]
  )

  useComponentScopedRunner(daemons)

  return <>{children}</>
}
