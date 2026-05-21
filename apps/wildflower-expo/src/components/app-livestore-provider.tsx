import { StoreRegistry, StoreRegistryProvider } from '@livestore/react'
import { Effect, Fiber, Layer } from 'effect'
import { type JSX, type PropsWithChildren, Suspense, useEffect, useState } from 'react'
import { Text } from 'react-native'
import { TunnelStore } from 'tunnel-core/livestore'
import { TunnelDaemon } from 'tunnel-expo'
import { HttpServerDaemonLive } from '../daemons/http-server.ts'
import { useWildflowerStore, WildflowerStore } from '../livestore/livestore-store.ts'

/**
 * Wrap the Expo Router stack with the LiveStore registry context so
 * `useWildflowerStore()` downstream resolves to the shared
 * module-singleton store, and launch the on-device daemons (HTTP
 * server + tunnel) under React's mount lifecycle.
 */
export default function AppLivestoreProvider({ children }: PropsWithChildren): JSX.Element {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <Suspense fallback={<Text>Loading…</Text>}>
      <StoreRegistryProvider storeRegistry={storeRegistry}>
        <DaemonLauncher>{children}</DaemonLauncher>
      </StoreRegistryProvider>
    </Suspense>
  )
}

/**
 * Launch the merged HTTP-server + tunnel daemon Layer once the store
 * handle is available, and interrupt it cleanly on unmount.
 *
 * Lifecycle parity with `apps/wildflower-node/src/index.ts`: one
 * `Layer.launch` over `Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon)`,
 * one scope, one fiber. The wildflower store is provided once at the
 * outer layer; the tunnel slice gets its own projection.
 *
 * `useEffect` keyed on `store` gives StrictMode the standard cleanup
 * contract — the dev-only double-invoke tears down the first fiber
 * before the second starts, so we don't end up with two HTTP servers
 * racing the same port.
 */
function DaemonLauncher({ children }: PropsWithChildren): JSX.Element {
  const store = useWildflowerStore()

  useEffect(() => {
    const fiber = Effect.runFork(
      Layer.launch(
        Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon).pipe(
          Layer.provide(
            Layer.mergeAll(Layer.succeed(WildflowerStore, store), TunnelStore.layerFrom(store))
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
