import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { type JSX, type ReactNode, useState } from 'react'

const ONE_DAY_MS = 1000 * 60 * 60 * 24

/**
 * QueryClient defaults shared by every screen in the app:
 *
 *   - `staleTime: 0` — every query is stale on mount, so the very next
 *     render after the persister hydrates from localStorage kicks off a
 *     background refetch. The cached value renders immediately; the
 *     fresh value swaps in once it returns.
 *   - `gcTime: 24h` — keep queries in cache long enough for the
 *     persister to round-trip them through localStorage between
 *     sessions. Without this, queries would be garbage-collected after
 *     5 minutes of being unused and the persister would have nothing to
 *     write.
 *   - `refetchOnWindowFocus: false` — the embedded WebView has no
 *     stable focus story (frequent host bridge re-renders trigger
 *     spurious focus events); the on-mount refetch already gives us
 *     stale-while-revalidate.
 */
const buildQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 0,
        gcTime: ONE_DAY_MS,
        refetchOnWindowFocus: false,
      },
    },
  })

/**
 * Mount inside the app root. Wires a process-local {@link QueryClient}
 * and a localStorage-backed persister so every cached query survives
 * page reloads + WebView remounts. Pair with `useSuspenseQuery` /
 * `useMutation` calls in slice hooks (see `apps-react` and
 * `tunnel-react`'s `queries.ts`).
 *
 * @remarks
 * `window.localStorage` is read inside `useState` initializers so the
 * module can be imported in environments without a DOM (the embedded
 * bundle's pre-hydration build pass) without crashing at import time.
 */
const QueryClientPersistProvider = ({
  children,
}: {
  readonly children: ReactNode
}): JSX.Element => {
  const [queryClient] = useState(buildQueryClient)
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
