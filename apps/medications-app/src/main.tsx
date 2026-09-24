import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The design-system stylesheet stack (tundra-css, the Wildflower palette and
// type scale, the self-hosted fonts) in its load-bearing order. Imported before
// the app's own CSS modules so app styles win on tied specificity.
import 'react-tundraish/styles'

import { restoreRedirectedUrl } from 'branding-core'
import { addOsColorSchemeListener } from 'react-tundraish'
import { AppRoot } from './app-root.tsx'

// Complete a GitHub Pages 404 redirect before anything reads the URL — see
// "The 404 redirect" in `slices/branding/AGENTS.md`.
restoreRedirectedUrl(window)

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
