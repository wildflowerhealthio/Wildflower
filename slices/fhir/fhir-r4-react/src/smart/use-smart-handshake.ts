import { hashKey, queryOptions, useQuery, type Query } from '@tanstack/react-query'
import { Data, Effect, Either, Match } from 'effect'
import { useEffect, useMemo } from 'react'

import { launchErrorBodyFor, launchErrorRedirect } from './launch-error.ts'
import {
  completeSignInAfterRedirectHere,
  type SignInAfterRedirectError,
  type SignInLanding,
} from './sign-in-after-redirect.ts'
import type { SmartConnection } from './smart-connection.ts'

/**
 * The state of completing the SMART handshake on the redirect page: still
 * exchanging, failed, or resolved to the {@link SmartConnection} it made.
 */
type SmartHandshake = Data.TaggedEnum<{
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  readonly Connecting: Record<never, never>
  readonly Failed: { readonly error: SignInAfterRedirectError }
  readonly Ready: { readonly connection: SmartConnection }
}>
const SmartHandshake = Data.taggedEnum<SmartHandshake>()
const {
  Connecting: connectingHandshake,
  Failed: failedHandshake,
  Ready: readyHandshake,
} = SmartHandshake

/**
 * The key the handshake query runs under. App-independent and constant so that
 * every mount of {@link useSmartHandshake} on the page shares the one exchange.
 */
const SMART_HANDSHAKE_QUERY_KEY = ['fhir-r4-react', 'smart-handshake'] as const

/**
 * The handshake query's settings: the key, typed so a read of its data is the
 * handshake's outcome, the {@link SmartConnection} it made or why it failed.
 *
 * @remarks
 * The failure is the query's data rather than its error, so it keeps its
 * type. A defect (a bug, not a failure) is the query's error, and is thrown
 * to the nearest error boundary (`throwOnError`).
 *
 * `retry: false` because re-POSTing a consumed code cannot succeed. `staleTime`
 * and `gcTime` are `Infinity` because there is nothing to refetch — the
 * handshake is a one-shot whose result lives for the page.
 */
const smartHandshakeQueryBase = queryOptions<
  Either.Either<SmartConnection, SignInAfterRedirectError>
>({
  queryKey: SMART_HANDSHAKE_QUERY_KEY,
  retry: false,
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnWindowFocus: false,
  throwOnError: true,
})

/**
 * Complete the SMART handshake exactly once, as a TanStack Query, and report its
 * state.
 *
 * @param landing - The sign-in the page landed on, the registration it
 *   redeems as, and the redirect URI the token request names
 *
 * @remarks
 * This is the one hook that runs the exchange. The authorization code in the
 * redirect URL is single-use: the token exchange (`completeSignInAfterRedirectHere` →
 * `authorization-core`'s `completeSignIn`, the POST to the token endpoint)
 * may run **once, ever**. Routing it through a keyed query is what makes that
 * hold under `React.StrictMode`, whose dev-only mount → unmount → mount would
 * fire a bare `useEffect` twice — the second run finding the single-use
 * retained sign-in request already taken and failing the handshake. Query-level dedup
 * means both mounts attach to the one in-flight exchange instead.
 *
 * Requires a `QueryClientProvider` above it; {@link buildSmartQueryClient}
 * builds the client the app provides.
 */
const useSmartHandshake = (
  landing: Pick<SignInLanding, 'arrival' | 'registration' | 'appRootRedirectUri'>
): SmartHandshake => {
  const { data } = useQuery({
    ...smartHandshakeQueryBase,
    queryFn: () => Effect.runPromise(Effect.either(completeSignInAfterRedirectHere(landing))),
  })
  // Memoised on the outcome, so an effect keyed on the handshake runs once it settles.
  return useMemo(
    (): SmartHandshake =>
      data === undefined
        ? connectingHandshake()
        : Either.match(data, {
            onLeft: (error) => failedHandshake({ error }),
            onRight: (connection) => readyHandshake({ connection }),
          }),
    [data]
  )
}

/**
 * Whether `query` is the SMART handshake {@link useSmartHandshake} runs.
 *
 * @remarks
 * For a client-wide query callback (`buildSmartQueryClient`'s `onQueryError`)
 * that treats the handshake apart from the app's reads. A failed handshake is
 * the query's data, sent back to the app root by
 * {@link useRedirectToRootOnFailure}, where it lands as the launch failure the
 * page arrived with; what fails the query itself is a defect, thrown to the
 * error boundary that reports it.
 */
const isSmartHandshakeQuery = (query: Pick<Query, 'queryKey'>): boolean =>
  hashKey(query.queryKey) === hashKey(smartHandshakeQueryBase.queryKey)

/**
 * Send a failed handshake back to the app root at `appRootRedirectUri`,
 * carrying its reason as `?launchError` for the root's `ErrorBanner` to
 * render.
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
const useRedirectToRootOnFailure = (
  handshake: SmartHandshake,
  appRootRedirectUri: string
): void => {
  useEffect(() => {
    Match.value(handshake).pipe(
      Match.tag('Failed', ({ error }) => {
        window.location.replace(
          launchErrorRedirect(appRootRedirectUri, launchErrorBodyFor('HandshakeFailed', error))
        )
      }),
      Match.orElse(() => undefined)
    )
  }, [handshake, appRootRedirectUri])
}

export {
  isSmartHandshakeQuery,
  SMART_HANDSHAKE_QUERY_KEY,
  useRedirectToRootOnFailure,
  useSmartHandshake,
  SmartHandshake,
}
