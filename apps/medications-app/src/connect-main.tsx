import { ConnectMenu } from 'fhir-r4-react/connect'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Same design-system + font stylesheets as `main.tsx` — this page is a peer
// entry, not served through it, so it loads them itself.
import 'tundra-css'
import 'react-tundraish/styles.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'

import { startColorSchemeSync } from './color-scheme.ts'
import { standaloneSmartConfig } from './config.ts'

// Mirror the OS colour preference onto `data-color-scheme`, same as `main.tsx`.
startColorSchemeSync()

// The OAuth redirect target is this app's origin root (which serves
// `index.html`), derived from this page's URL so it works at whatever subdomain
// the self-hosted bundle is served from — the same value `launch-main.ts`
// computes, so the standalone callback path is shared with the EHR launch.
const redirectUri = new URL('.', window.location.href).href

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <ConnectMenu
        clientId={standaloneSmartConfig.clientId}
        scope={standaloneSmartConfig.scope}
        redirectUri={redirectUri}
      />
    </StrictMode>
  )
}
