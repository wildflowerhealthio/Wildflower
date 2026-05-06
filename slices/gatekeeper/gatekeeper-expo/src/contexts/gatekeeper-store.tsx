import type { Store } from '@livestore/livestore'
import type { ReactApi } from '@livestore/react'
import type { schema as gatekeeperSchema } from 'gatekeeper-core/livestore'
import { createContext, type JSX, type ReactNode, useContext } from 'react'

type GatekeeperStore = Store<typeof gatekeeperSchema, object> & ReactApi

const GatekeeperStoreContext = createContext<GatekeeperStore | null>(null)

interface GatekeeperStoreProviderProps<TSchema extends typeof gatekeeperSchema> {
  /**
   * A live `Store` whose schema is a superset of `gatekeeper-core/livestore`'s
   * `schema` — typically the host app's full store. Schema variance forces
   * an internal `unknown` cast at the provider boundary; downstream
   * consumers see the narrower gatekeeper schema.
   */
  store: Store<TSchema, object> & ReactApi
  children: ReactNode
}

function GatekeeperStoreProvider<TSchema extends typeof gatekeeperSchema>({
  store,
  children,
}: GatekeeperStoreProviderProps<TSchema>): JSX.Element {
  return (
    <GatekeeperStoreContext.Provider
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Store schema is invariant; narrowing requires an `unknown` cast
      value={store as unknown as GatekeeperStore}
    >
      {children}
    </GatekeeperStoreContext.Provider>
  )
}

function useGatekeeperStore(): GatekeeperStore {
  const store = useContext(GatekeeperStoreContext)
  if (store === null) {
    throw new Error('useGatekeeperStore must be used within a GatekeeperStoreProvider')
  }
  return store
}

// oxlint-disable-next-line react/only-export-components -- standard context pattern: provider + consumer hook
export { GatekeeperStoreProvider, useGatekeeperStore }
export type { GatekeeperStore, GatekeeperStoreProviderProps }
