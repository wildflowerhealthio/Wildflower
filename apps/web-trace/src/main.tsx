import { ConnectMenu } from 'fhir-r4-react/connect'
import { shouldCompleteSmartLaunch } from 'fhir-r4-react/smart'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Design-system stylesheets: tundra-css supplies the base tokens/reset, then
// react-tundraish re-points them to the Wildflower palette + type scale. Loaded
// before the app's own CSS module so app styles win on tied specificity.
import 'tundra-css'
import 'react-tundraish/styles.css'
// Self-hosted UI font (Atkinson Hyperlegible Next) that `--font-sans` resolves
// to; the italic cut carries emphasis. Mono is reserved for machine strings —
// which this app is full of, so it earns its place here.
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'

import { App } from './app.tsx'
import { startColorSchemeSync } from './color-scheme.ts'
import { standaloneSmartConfig } from './config.ts'

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS.
startColorSchemeSync()

// The app root is both the OAuth redirect target and the standalone landing
// page. A callback in the URL (`code`/`state`, no `error`) means there is a
// handshake to complete, so render `App`; otherwise show the connect menu.
// `ConnectMenu`'s redirect target is this same root, derived from the current
// URL so it works at whatever subdomain the self-hosted bundle is served from.
const redirectUri = new URL('.', window.location.href).href

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      {shouldCompleteSmartLaunch() ? (
        <App />
      ) : (
        <ConnectMenu
          clientId={standaloneSmartConfig.clientId}
          scope={standaloneSmartConfig.scope}
          redirectUri={redirectUri}
        />
      )}
    </StrictMode>
  )
}
