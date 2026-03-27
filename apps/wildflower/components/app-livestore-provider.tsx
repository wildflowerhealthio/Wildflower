import { StoreRegistry } from '@livestore/livestore'
import { StoreRegistryProvider } from '@livestore/react'
import React, { JSX, Suspense, useState } from 'react'
import { Text } from 'react-native'

// oxlint-disable-next-line typescript/no-empty-object-type
interface AppLivestoreProviderProps {}

export default function AppLivestoreProvider({
  children,
}: React.PropsWithChildren<AppLivestoreProviderProps>): JSX.Element {
  // const [, rerender] = React.useState({})

  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <Suspense fallback={<Text>Loading LiveStore...</Text>}>
      <StoreRegistryProvider storeRegistry={storeRegistry}>
        {/* <LiveStoreProvider
        schema={schema}
        adapter={adapter}
        storeId={storeId}
        syncPayload={{ authToken: 'insecure-token-change-me' }}
        renderLoading={(_: unknown) => }
        renderError={(error: any) => <Text>Error: {error.toString()}</Text>}
        renderShutdown={() => {
          return (
            <View>
              <Text>LiveStore Shutdown</Text>
              <Button title="Reload" onPress={() => rerender({})} />
            </View>
          )
        }}
        boot={(_store: unknown) => {}}
        batchUpdates={batchUpdates}
      > */}
        {children}
        {/* </LiveStoreProvider> */}
      </StoreRegistryProvider>
    </Suspense>
  )
}
