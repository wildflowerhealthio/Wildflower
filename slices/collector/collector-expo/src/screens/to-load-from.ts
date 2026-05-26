import type { WebViewSource } from 'collector-fundamentals/model'
import type { BridgedWebViewLoadFrom } from 'effect-messaging-expo'

const FALLBACK_BASE_URL = 'about:blank' as const

/** Convert {@link WebViewSource.Any} to {@link BridgedWebViewLoadFrom}. */
const toLoadFrom = (source: WebViewSource.Any): BridgedWebViewLoadFrom =>
  source._tag === 'Uri'
    ? { _tag: 'uri', uri: source.uri }
    : // Collector schema makes `baseUrl` optional; `BridgedWebView`
      // requires it as the origin for `initialMessages`. Falling back
      // to `about:blank` keeps the WebView mountable — relative URLs
      // in the html source won't resolve, but the page renders.
      { _tag: 'html', html: source.html, baseUrl: source.baseUrl ?? FALLBACK_BASE_URL }

export { FALLBACK_BASE_URL, toLoadFrom }
