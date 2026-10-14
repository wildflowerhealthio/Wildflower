import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The design-system stylesheet stack, then the shared chrome's layout tokens,
// ahead of the app's own CSS modules so app styles win on tied specificity.
import '@wildflowerhealthio/react-tundraish/styles'
import '@wildflowerhealthio/branding-react/styles.css'

import { FetchHttpClient } from '@effect/platform'
import { createBrowserHistory } from '@tanstack/react-router'
import { basenameOf, restoreRedirectedUrl } from '@wildflowerhealthio/branding-core'
import { addOsColorSchemeListener } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { ConsentedEntryRoot, SignedInApp, SignedOutApp } from './app-root.tsx'
import { browserBoot } from './boot.ts'

// The directory this build is served from, the router's basepath. Read before
// `restoreRedirectedUrl` puts a deep route back in the address bar, after
// which `basenameOf` would fold that route's segments into the answer.
const basepath = basenameOf(window.location.pathname)

// Complete a GitHub Pages 404 redirect before anything reads the URL — see
// "The 404 redirect" in `slices/branding/AGENTS.md`.
restoreRedirectedUrl(window)

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette tracks the OS.
addOsColorSchemeListener()

/**
 * Redeem the sign-in this load returned with, if any, then build the page for
 * what came of it: the signed-in app, or the landing. Runs once the visitor has
 * answered the telemetry consent dialog.
 */
const bootApp = async (): Promise<JSX.Element> => {
  const boot = await browserBoot(window, basepath)
  return boot.tag === 'SignedIn' ? (
    <SignedInApp
      session={boot.session}
      history={createBrowserHistory()}
      basepath={basepath}
      transport={FetchHttpClient.layer}
      // The bearer is short-lived and there is no refresh token. Reloading
      // lands on the landing at this route's `?iss=` address, which signs in
      // again straight away and returns here.
      onSessionExpired={() => {
        window.location.reload()
      }}
    />
  ) : (
    <SignedOutApp {...boot.landing} />
  )
}

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <ConsentedEntryRoot bootApp={bootApp} />
    </StrictMode>
  )
}
