import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import type { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { type JSX, type ReactNode, useState } from 'react'

import { ONE_DAY_MS } from './router-context.ts'

/**
 * Mount at the app root, wrapping the ENTIRE provider/router subtree.
 * Wires the shared {@link QueryClient} and a localStorage-backed
 * persister so every cached query survives page reloads + WebView
 * remounts. Pair with `useSuspenseQuery` / `useMutation` calls in slice
 * hooks (see `apps-react` and `tunnel-react`'s `queries.ts`) and with
 * route `loader`s that call `context.queryClient.ensureQueryData(...)`.
 *
 * The `queryClient` is supplied by the caller (rather than built
 * internally) so the identical instance can also be threaded into the
 * router context — see `buildQueryClient` (`router-context.ts`) and
 * `renderApp` (`app-root.tsx`).
 *
 * @remarks
 * `window.localStorage` is read inside a `useState` initializer so the
 * module can be imported in environments without a DOM (the embedded
 * bundle's pre-hydration build pass) without crashing at import time.
 */
const QueryClientPersistProvider = ({
  queryClient,
  children,
}: {
  readonly queryClient: QueryClient
  readonly children: ReactNode
}): JSX.Element => {
  const [persister] = useState(() =>
    createSyncStoragePersister({
      storage: window.localStorage,
      key: 'wildflower-react-query',
    })
  )
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: ONE_DAY_MS }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}

export { QueryClientPersistProvider }
