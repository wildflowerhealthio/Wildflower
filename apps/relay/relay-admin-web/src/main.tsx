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
import { RelayAdminHttpApiClient } from 'relay-core-js/clients'
import { signingHttpClient } from 'relay-core-js/signing'
import { adminKeyStoreIndexedDb, RelayAdminProvider, RelayAdminScreen } from 'relay-react'

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS.
addOsColorSchemeListener()

/**
 * `fetch`, with every admin request signed here: `signingHttpClient` signs
 * each request with the admin key in IndexedDB before `fetch` sends it. The
 * page is served by the relay on `admin.<domain>`, so the API is this page's
 * own origin.
 */
const signedFetch = signingHttpClient(window.location.origin).pipe(
  Layer.provide(Layer.merge(FetchHttpClient.layer, adminKeyStoreIndexedDb))
)

/**
 * The admin API client over `signedFetch`, and the key store itself, which
 * the screen saves the pasted key to and clears on Sign out.
 */
const runtime = ManagedRuntime.make(
  Layer.merge(
    RelayAdminHttpApiClient.layer.pipe(Layer.provide(signedFetch)),
    adminKeyStoreIndexedDb
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
