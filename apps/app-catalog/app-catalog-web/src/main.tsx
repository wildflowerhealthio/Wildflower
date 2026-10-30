import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The design-system stylesheet stack in its load-bearing order, before the
// page's own CSS modules so they win on tied specificity.
import '@wildflowerhealthio/react-tundraish/styles'

import { CATALOG_JSON_PATH } from '@wildflowerhealthio/app-catalog-core-js/location'
import { restoreRedirectedUrl } from '@wildflowerhealthio/branding-core'
import { addOsColorSchemeListener } from '@wildflowerhealthio/react-tundraish'
import { CatalogPage } from './catalog-page.tsx'

// Complete a GitHub Pages 404 redirect before anything reads the URL — see
// "The 404 redirect" in `slices/branding/AGENTS.md`.
restoreRedirectedUrl(window)

addOsColorSchemeListener()

/**
 * The directory the build is served from, read off this module's URL, which
 * sits one directory below it (`assets/` in a build, `src/` under the dev
 * server), as `smart-app-react`'s `servedDirectoryOf` reads it. The page's own
 * URL cannot say: a 404 redirect lands it on a deep route. A function of the
 * URL rather than `new URL('..', import.meta.url)` inline, which Vite would
 * rewrite as an asset reference.
 */
const servedDirectoryOf = (moduleUrl: string): string => new URL('..', moduleUrl).pathname

const catalogJsonPath = `${servedDirectoryOf(import.meta.url)}${CATALOG_JSON_PATH}`

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <CatalogPage catalogJsonPath={catalogJsonPath} />
    </StrictMode>
  )
}
