import { computed, type LiveQueryDef } from '@livestore/livestore'

import { queries as serverStateQueries } from './server-state.ts'

/**
 * Loopback origin the on-device HTTP server is bound to —
 * `http://${localHostname}:${port}` derived live from `ServerState`.
 *
 * Distinct from `tunnel-core`'s `servedOrigin$`, which prefers the public
 * tunnel URL when one is up. Use this when the consumer must reach the
 * server over the loopback interface specifically — e.g. the embedded
 * SPA inside a WebView, where every API call should hit `127.0.0.1`
 * regardless of tunnel state to avoid round-tripping through the public
 * relay (and its captive-portal interstitial).
 */
const localOrigin$: LiveQueryDef<string> = computed(
  (get) => {
    const server = get(serverStateQueries.current$)
    return `http://${server.localHostname}:${server.port}`
  },
  { label: 'localOrigin', deps: 'local-http-server.localOrigin@v1' }
)

export { localOrigin$ }
