import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The design-system stylesheet stack (tundra-css, the Wildflower palette and
// type scale, the self-hosted fonts) in its load-bearing order. Imported before
// the app's own CSS modules so app styles win on tied specificity.
import '@wildflowerhealthio/react-tundraish/styles'

import { FetchHttpClient } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { addOsColorSchemeListener, pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'

import { ownerBrowserSessionRunner } from '../owner-browser-session.ts'
import { goBackOnceDecidedOf } from '../then-query.ts'
import { ConsentPage } from './consent-page.tsx'
import { requestIdOf } from './request-path.ts'

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS.
addOsColorSchemeListener()

const queryClient = new QueryClient()

const leaveFor = (destination: URL): void => {
  window.location.replace(destination.href)
}

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <main className={pageLayoutStyles['page']}>
          <ConsentPage
            requestId={requestIdOf(window.location.pathname)}
            runAuthed={ownerBrowserSessionRunner(window.location.origin, FetchHttpClient.layer)}
            waitPage={new URL('wait', window.location.href)}
            leaveFor={leaveFor}
            goBackOnceDecided={goBackOnceDecidedOf(window.location.search, window)}
          />
        </main>
      </QueryClientProvider>
    </StrictMode>
  )
}
