import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// The same stylesheet stack as `main.tsx`, in the same order, so the launch
// page is the app's own chrome rather than an unstyled interstitial: tundra-css
// supplies the base tokens/reset, react-tundraish re-points them to the
// Wildflower palette + type scale, and branding-react adds the layout tokens.
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'branding-react/styles.css'
// Self-hosted UI font (Atkinson Hyperlegible Next) that `--font-sans` resolves
// to. Only the upright cut: this page is one line of copy and is gone in a
// redirect, so the italic and mono cuts would be paid for and never shown.
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'

import { BrandBar } from 'branding-react'
import { authorizeSmartLaunch, launchErrorBodyFor, launchErrorRedirect } from 'fhir-r4-react/smart'
import { addOsColorSchemeListener, PageLoading } from 'react-tundraish'

import { smartConfig } from './config.ts'

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS —
// without it this page flashes light before the app root picks the scheme up.
addOsColorSchemeListener()

// The slim brand bar over the loading copy: the shape `BrandBar` exists for (a
// SMART-launched app and the Tauri shell), and the same `PageLoading` the
// desktop app shows while its own handshake is in flight. Mounted before the
// authorize call so the page is never blank while discovery is in flight.
const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <BrandBar />
      <main>
        <PageLoading message="Launching Medications…" />
      </main>
    </StrictMode>
  )
}

// The OAuth redirect target is this app's origin root (which serves
// `index.html`), derived from the launch page URL so it works at whatever
// subdomain the self-hosted bundle is served from.
const redirectUri = new URL('.', window.location.href).href

// A launch that never reaches the authorization server fails here — an
// unreachable or CORS-blocked `iss`, a server that serves no SMART config, a
// client id or redirect URI the server does not know. This page has no UI to
// report that in, so hand the failure to the app root (which does, via
// `ErrorBanner`) rather than leaving the user on a loading line forever.
void authorizeSmartLaunch({ ...smartConfig, redirectUri }).catch((error: unknown) => {
  window.location.replace(
    launchErrorRedirect(redirectUri, launchErrorBodyFor('AuthorizeFailed', error))
  )
})
