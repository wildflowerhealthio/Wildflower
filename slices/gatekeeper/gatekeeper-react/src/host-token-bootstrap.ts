import { writeToken } from './client/token-storage.ts'

type WindowWithToken = Window & { __GATEKEEPER_TOKEN__?: unknown }

// Side-effect bootstrap module. The SPA host (apps/wildflower-react) imports
// this for its effect: pull the bearer token from one of two sources, stash
// to localStorage so the HttpApi client can read it on every request.
//   1. `window.__GATEKEEPER_TOKEN__` — set by the RN host before the bundle
//      runs (see `gatekeeper-expo/GatekeeperWebView`).
//   2. `?token=` — set when the SPA is loaded standalone in a browser.
//      Stripped from the address bar so it doesn't persist in history or
//      Referer headers. See gatekeeper-core README's "Bootstrap URL".
if (typeof window !== 'undefined') {
  const injected = (window as WindowWithToken).__GATEKEEPER_TOKEN__
  if (typeof injected === 'string' && injected !== '') {
    writeToken(injected)
  }

  const url = new URL(window.location.href)
  const tokenFromUrl = url.searchParams.get('token')
  if (tokenFromUrl !== null && tokenFromUrl !== '') {
    writeToken(tokenFromUrl)
    url.searchParams.delete('token')
    window.history.replaceState(null, '', url.toString())
  }
}
