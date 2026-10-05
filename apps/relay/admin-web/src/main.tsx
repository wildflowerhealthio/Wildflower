import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The design-system stylesheet stack (tundra-css, the Wildflower palette and
// type scale, the self-hosted fonts) in its load-bearing order. Imported before
// the app's own CSS modules so app styles win on tied specificity.
import 'react-tundraish/styles'

import { FetchHttpClient } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layer, ManagedRuntime } from 'effect'
import { addOsColorSchemeListener } from 'react-tundraish'
import { RelayAdminHttpApiClient } from 'relay-core/clients'
import { signingHttpClient } from 'relay-core/signing'
import { adminKeyStoreIndexedDb, RelayAdminProvider, RelayAdminScreen } from 'relay-react'

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS.
addOsColorSchemeListener()

/**
 * The admin API client over `fetch`, every request signed with the admin key
 * in IndexedDB. The page is served by the relay on `admin.<domain>`, so the
 * API is this page's own origin.
 */
const runtime = ManagedRuntime.make(
  RelayAdminHttpApiClient.layer.pipe(
    Layer.provide(signingHttpClient(window.location.origin)),
    Layer.provideMerge(adminKeyStoreIndexedDb),
    Layer.provide(FetchHttpClient.layer)
  )
)

const queryClient = new QueryClient({
  // A refused key is dealt with at once (the key form comes back), and other
  // failures are the relay's considered answers; neither improves on retry.
  defaultOptions: { queries: { retry: false } },
})

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RelayAdminProvider runtime={runtime}>
          <RelayAdminScreen host={window.location.host} />
        </RelayAdminProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
