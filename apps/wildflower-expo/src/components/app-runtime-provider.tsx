import { StoreRegistryProvider } from '@livestore/react'
import { type JSX, type PropsWithChildren, Suspense } from 'react'
import { Text } from 'react-native'
import { useBackgroundServerDaemon } from '../daemons/background-server.ts'
import { useWildflowerStore, wildflowerStoreRegistry } from '../livestore/livestore-store.ts'

/**
 * Root runtime context for the on-device app shell: wires the
 * `@livestore/react` registry context (so `useWildflowerStore()`
 * downstream resolves to the shared module-singleton store) and
 * launches the on-device daemons (HTTP server + tunnel) inside a
 * `react-native-background-actions` foreground service that is
 * mounted/started under React's lifecycle inside that registry context.
 *
 * The registry itself is owned by `livestore-store.ts` and warmed at
 * module-eval — see {@link wildflowerStoreRegistry}.
 */
export default function AppRuntimeProvider({ children }: PropsWithChildren): JSX.Element {
  return (
    <Suspense fallback={<Text>Loading AppRuntimeProvider …</Text>}>
      <StoreRegistryProvider storeRegistry={wildflowerStoreRegistry}>
        <DaemonRuntimeScope>{children}</DaemonRuntimeScope>
      </StoreRegistryProvider>
    </Suspense>
  )
}

/**
 * Drives the on-device daemon launch (HTTP server + tunnel) through a
 * background foreground service via {@link useBackgroundServerDaemon}.
 * Unlike the prior `useComponentScopedRunner` launch — whose Effect scope
 * lived only as long as the React mount in the foreground — the service
 * keeps the merged daemon alive while the app is backgrounded (long-lived
 * on Android, best-effort within iOS's limited background window) and tears
 * it down cleanly when stopped (unmount, `requestedRunning` → false, or the
 * OS reclaiming the task).
 *
 * Component, not hook — `useWildflowerStore()` consumes the registry
 * context provided one level up by `<StoreRegistryProvider>` and
 * suspends on the store load.
 */
function DaemonRuntimeScope({ children }: PropsWithChildren): JSX.Element {
  const store = useWildflowerStore()
  useBackgroundServerDaemon(store)
  return <>{children}</>
}
