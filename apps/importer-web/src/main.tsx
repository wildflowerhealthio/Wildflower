import { QueryClientProvider } from '@tanstack/react-query'
import { ConnectMenu } from 'fhir-r4-react/connect'
import { buildSmartQueryClient, shouldCompleteSmartLaunch } from 'fhir-r4-react/smart'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Design-system stylesheets: tundra-css supplies the base tokens/reset, then
// react-tundraish re-points them to the Wildflower palette + type scale. Loaded
// before the app's own CSS module so app styles win on tied specificity.
import 'tundra-css'
import 'react-tundraish/styles.css'
// Self-hosted UI font (Atkinson Hyperlegible Next) that `--font-sans` resolves
// to; the italic cut carries emphasis. Mono is reserved for machine strings —
// the preview lists resource types and ids, and the results list failed writes
// by reference, so it earns its place here.
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'

import { addOsColorSchemeListener } from 'react-tundraish'
import { App } from './app.tsx'
import { standaloneSmartConfig } from './config.ts'

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS.
addOsColorSchemeListener()

// The app root is both the OAuth redirect target and the standalone landing
// page. A callback in the URL (`code`/`state`, no `error`) means there is a
// handshake to complete, so render `App`; otherwise show the connect menu.
// `ConnectMenu`'s redirect target is this same root, derived from the current
// URL so it works at whatever subdomain / path the bundle is served from.
const redirectUri = new URL('.', window.location.href).href

// One QueryClient for the whole page: `App` completes the SMART handshake as a
// query on it (via `useSmartHandshake`), then hands this same instance to its
// router context, so the exchange and every app read/write share one cache.
const queryClient = buildSmartQueryClient()

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {shouldCompleteSmartLaunch() ? (
          <App />
        ) : (
          <ConnectMenu
            clientId={standaloneSmartConfig.clientId}
            scope={standaloneSmartConfig.scope}
            redirectUri={redirectUri}
          />
        )}
      </QueryClientProvider>
    </StrictMode>
  )
}
