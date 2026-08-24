import { useQuery } from '@tanstack/react-query'
import type Client from 'fhirclient/lib/Client'

import { readySmartClient } from './smart-launch.ts'

/**
 * The state of completing the SMART handshake on the redirect page: still
 * exchanging, failed, or resolved to a ready {@link Client}.
 */
type SmartHandshake =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly client: Client }

/**
 * The key the handshake query runs under. App-independent and constant so that
 * every mount of {@link useSmartHandshake} on the page shares the one exchange.
 */
const SMART_HANDSHAKE_QUERY_KEY = ['fhir-r4-react', 'smart-handshake'] as const

/**
 * Complete the SMART handshake exactly once, as a TanStack Query, and report its
 * state.
 *
 * @remarks
 * The authorization code in the redirect URL is single-use: the token exchange
 * (`readySmartClient` → fhirclient's `oauth2.ready()`, the POST to
 * `/oauth/token`) may run **once, ever**. Routing it through a keyed query is
 * what makes that hold under `React.StrictMode`, whose dev-only
 * mount → unmount → mount would fire a bare `useEffect` twice and POST the same
 * code twice — the second exchange then failing against an already-redeemed
 * code (fhirclient's own guard only suppresses a *sequential* reload, after the
 * first exchange has persisted; two near-simultaneous calls both read the
 * pre-exchange state and both POST). Query-level dedup means both mounts attach
 * to the one in-flight exchange instead.
 *
 * `retry: false` because re-POSTing a consumed code cannot succeed. `staleTime`
 * and `gcTime` are `Infinity` because there is nothing to refetch — the
 * handshake is a one-shot whose result lives for the page. Requires a
 * `QueryClientProvider` above it; {@link buildSmartQueryClient} builds the
 * client the app provides.
 */
const useSmartHandshake = (): SmartHandshake => {
  const query = useQuery({
    queryKey: SMART_HANDSHAKE_QUERY_KEY,
    queryFn: () => readySmartClient(),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  })
  if (query.isSuccess) return { kind: 'ready', client: query.data }
  if (query.isError) return { kind: 'error', error: query.error }
  return { kind: 'connecting' }
}

export { SMART_HANDSHAKE_QUERY_KEY, useSmartHandshake, type SmartHandshake }
