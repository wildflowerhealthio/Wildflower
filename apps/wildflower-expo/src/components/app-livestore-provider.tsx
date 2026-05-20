import { StoreRegistry, StoreRegistryProvider } from '@livestore/react'
import { type JSX, type PropsWithChildren, Suspense, useState } from 'react'
import { Text } from 'react-native'

/**
 * Wrap the Expo Router stack with the LiveStore registry context so
 * `useWildflowerStore()` downstream resolves to the shared
 * module-singleton store.
 */
export default function AppLivestoreProvider({ children }: PropsWithChildren): JSX.Element {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <Suspense fallback={<Text>Loading…</Text>}>
      <StoreRegistryProvider storeRegistry={storeRegistry}>{children}</StoreRegistryProvider>
    </Suspense>
  )
}
