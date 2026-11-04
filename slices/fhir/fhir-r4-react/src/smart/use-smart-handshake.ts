import {
  hashKey,
  queryOptions,
  skipToken,
  useQuery,
  type Query,
  type QueryClient,
} from '@tanstack/react-query'
import { Option } from 'effect'
import { useEffect } from 'react'

import { launchErrorBodyFor, launchErrorRedirect } from './launch-error.ts'
import type { SmartClient } from './smart-client.ts'
import { appRootRedirectUri, readySmartClient, type SmartLaunchConfig } from './smart-launch.ts'

/**
 * The state of completing the SMART handshake on the redirect page: still
 * exchanging, failed, or resolved to a ready {@link SmartClient}.
 */
type SmartHandshake =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly client: SmartClient }

/**
 * The key the handshake query runs under. App-independent and constant so that
 * every mount of {@link useSmartHandshake} on the page shares the one exchange.
 */
const SMART_HANDSHAKE_QUERY_KEY = ['fhir-r4-react', 'smart-handshake'] as const

/**
 * The handshake query's settings, shared by the one hook that runs it and
 * the one that only reads it: the key, typed so a read of its data is a
 * {@link SmartClient}.
 *
 * @remarks
 * `retry: false` because re-POSTing a consumed code cannot succeed. `staleTime`
 * and `gcTime` are `Infinity` because there is nothing to refetch — the
 * handshake is a one-shot whose result lives for the page.
 */
const smartHandshakeQueryBase = queryOptions<SmartClient>({
  queryKey: SMART_HANDSHAKE_QUERY_KEY,
  retry: false,
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnWindowFocus: false,
})

/**
 * Complete the SMART handshake exactly once, as a TanStack Query, and report its
 * state.
 *
 * @param registration - The app's SMART registration, which the code is
 *   redeemed as
 * @param servedDirectory - The directory the app is served from, as
 *   `appRootRedirectUri` takes it, so the token request names the redirect
 *   URI the launch sent
 *
 * @remarks
 * This is the one hook that runs the exchange; everything else reads its
 * result with {@link useSmartClient}. The authorization code in the redirect
 * URL is single-use: the token exchange (`readySmartClient` →
 * `authorization-core`'s `completeSignIn`, the POST to the token endpoint)
 * may run **once, ever**. Routing it through a keyed query is what makes that
 * hold under `React.StrictMode`, whose dev-only mount → unmount → mount would
 * fire a bare `useEffect` twice — the second run finding the single-use
 * pending record already taken and failing the handshake. Query-level dedup
 * means both mounts attach to the one in-flight exchange instead.
 *
 * Requires a `QueryClientProvider` above it; {@link buildSmartQueryClient}
 * builds the client the app provides.
 */
const useSmartHandshake = (
  registration: Pick<SmartLaunchConfig, 'clientId' | 'scope'>,
  servedDirectory?: string
): SmartHandshake => {
  const query = useQuery({
    ...smartHandshakeQueryBase,
    queryFn: () => readySmartClient(registration, servedDirectory),
  })
  if (query.isSuccess) return { kind: 'ready', client: query.data }
  if (query.isError) return { kind: 'error', error: query.error }
  return { kind: 'connecting' }
}

/**
 * The {@link SmartClient} the page's SMART handshake resolved to, or `None`
 * while it has not (still exchanging, failed, or not started on this page).
 *
 * @remarks
 * Read-only: it observes the handshake query {@link useSmartHandshake} runs
 * and has no `queryFn` of its own (`skipToken`), so no reader can start the
 * single-use exchange, however it mounts. It re-renders when the handshake
 * settles.
 */
const useSmartClient = (): Option.Option<SmartClient> => {
  const query = useQuery({ ...smartHandshakeQueryBase, queryFn: skipToken })
  return Option.fromNullable(query.data)
}

/**
 * Call `onReady` once with the ready {@link SmartClient} when the SMART handshake on
 * `queryClient` completes, or at once if it already has.
 *
 * @param queryClient - The page's one client, where {@link useSmartHandshake}
 *   runs the exchange
 * @param onReady - Called with the ready client, at most once
 * @returns A function that stops listening
 *
 * @remarks
 * For code above the app that needs the connected server without running the
 * exchange itself: the app root, which provides `queryClient` while the app
 * beneath it calls {@link useSmartHandshake}. It reads the handshake query's
 * cached data and never starts the query, so it cannot fire the single-use
 * exchange a second time. A failed handshake never calls `onReady`.
 */
const whenSmartHandshakeReady = (
  queryClient: QueryClient,
  onReady: (client: SmartClient) => void
): (() => void) => {
  let notified = false
  const notifyIfReady = (): void => {
    if (notified) return
    const readyClient = queryClient.getQueryData(smartHandshakeQueryBase.queryKey)
    if (readyClient === undefined) return
    notified = true
    onReady(readyClient)
  }
  const unsubscribe = queryClient.getQueryCache().subscribe(notifyIfReady)
  notifyIfReady()
  return unsubscribe
}

/**
 * Whether `query` is the SMART handshake {@link useSmartHandshake} runs.
 *
 * @remarks
 * For a client-wide query callback (`buildSmartQueryClient`'s `onQueryError`)
 * that treats the handshake apart from the app's reads. A failed handshake is
 * sent back to the app root by {@link useLaunchFailureRedirect}, and lands
 * there as the launch failure the page arrived with.
 */
const isSmartHandshakeQuery = (query: Pick<Query, 'queryKey'>): boolean =>
  hashKey(query.queryKey) === hashKey(smartHandshakeQueryBase.queryKey)

/**
 * Send a failed handshake back to the app root, carrying its reason as
 * `?launchError` for the root's `ErrorBanner` to render.
 *
 * @remarks
 * A token exchange that fails leaves the user on the launched branch with a
 * consumed authorization code — there is nothing to retry *there*, because the
 * code is single-use and `useSmartHandshake` will not re-POST it. The app root
 * is the screen that can actually offer a way forward (the connect menu), so
 * the failure is carried to it rather than reported in a dead end.
 *
 * The target comes from {@link launchErrorRedirect}, which drops the OAuth
 * callback parameters — without that, the app root would re-enter the launched
 * branch and loop. The effect is deliberately not guarded against firing twice:
 * `location.replace` is idempotent for this purpose, and the handshake query is
 * `retry: false`, so the error state settles once.
 */
const useLaunchFailureRedirect = (handshake: SmartHandshake): void => {
  const failed = handshake.kind === 'error'
  const error = handshake.kind === 'error' ? handshake.error : undefined
  useEffect(() => {
    if (!failed) return
    const appRoot = appRootRedirectUri(window.location.href)
    window.location.replace(
      launchErrorRedirect(appRoot, launchErrorBodyFor('HandshakeFailed', error))
    )
  }, [failed, error])
}

export {
  isSmartHandshakeQuery,
  SMART_HANDSHAKE_QUERY_KEY,
  useLaunchFailureRedirect,
  useSmartClient,
  useSmartHandshake,
  whenSmartHandshakeReady,
  type SmartHandshake,
}
