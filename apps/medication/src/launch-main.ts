import { authorizeSmartLaunch } from 'fhir-r4-react/smart'

import { smartConfig } from './config.ts'

// The OAuth redirect target is this app's origin root (which serves
// `index.html`), derived from the launch page URL so it works at whatever
// subdomain the self-hosted bundle is served from.
const redirectUri = new URL('.', window.location.href).href

void authorizeSmartLaunch({ ...smartConfig, redirectUri }).catch((error: unknown) => {
  document.body.textContent = `SMART launch failed: ${error instanceof Error ? error.message : String(error)}`
})
