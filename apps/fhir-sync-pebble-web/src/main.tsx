import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The design-system stylesheet stack (tundra-css, the Wildflower palette and
// type scale, the self-hosted fonts) in its load-bearing order. Imported before
// the app's own CSS modules so app styles win on tied specificity.
import 'react-tundraish/styles'

import { restoreRedirectedUrl } from 'branding-core'
import { addOsColorSchemeListener } from 'react-tundraish'
import { AppRoot } from './app-root.tsx'
import * as ReturnTargetStore from './return-target-store.ts'

// Complete a GitHub Pages 404 redirect before anything reads the URL — see
// "The 404 redirect" in `slices/branding/AGENTS.md`.
restoreRedirectedUrl(window)

// Keep the Pebble phone app's `?return_to` before the SMART login navigates
// away: the OAuth callback lands back here without it.
ReturnTargetStore.fromWebStorage(window.sessionStorage).rememberFrom(new URL(window.location.href))

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS.
addOsColorSchemeListener()

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>
  )
}
