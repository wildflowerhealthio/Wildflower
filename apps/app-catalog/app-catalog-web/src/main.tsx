import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The design-system stylesheet stack in its load-bearing order, before the
// page's own CSS modules so they win on tied specificity.
import '@wildflowerhealthio/react-tundraish/styles'

import { restoreRedirectedUrl } from '@wildflowerhealthio/branding-core'
import { addOsColorSchemeListener } from '@wildflowerhealthio/react-tundraish'
import { CatalogPage } from './catalog-page.tsx'

// Complete a GitHub Pages 404 redirect before anything reads the URL — see
// "The 404 redirect" in `slices/branding/AGENTS.md`.
restoreRedirectedUrl(window)

addOsColorSchemeListener()

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <CatalogPage />
    </StrictMode>
  )
}
