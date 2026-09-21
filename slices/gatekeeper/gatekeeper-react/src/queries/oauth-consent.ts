import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { OAuthConsent } from 'gatekeeper-core/http-api-definition'

import type { RunAuthed } from '../router-context.ts'
import { GRANTS_QUERY_KEY, oauthConsentQueryKey } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type OAuthConsentResource = Schema.Schema.Type<typeof OAuthConsent.OAuthConsentSchema>
type OAuthConsentResult = Schema.Schema.Type<typeof OAuthConsent.OAuthConsentResultSchema>

type ApproveOAuthPayload = {
  readonly approvedScopes: readonly string[]
  readonly patient: string | null
  /**
   * Whether the Owner ticked the trust-on-first-use acknowledgment checkbox.
   * The server requires (and enforces) `true` whenever the consent's
   * `registration.status` is `new` or `changed`; send `false` for `registered`,
   * where no checkbox is shown.
   */
  readonly acknowledgedRegistration: boolean
}

const isConsentNotFound = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'error' in error &&
  error.error === 'OAuthConsentNotFound'

const EXPIRED_CONSENT_MESSAGE =
  'This authorization request has expired or was already completed. Return to the app and try connecting again.'

/**
 * The server treats an expired request as not found
 * (`load_pending_authorization_code_request` enforces the 5-minute TTL at read
 * time), so a consent screen left open past the deadline 404s on
 * approve/deny. Fold that
 * failure into the result's `error` arm with copy that tells the user the way
 * out — the raw "OAuthConsentNotFound" would read as a dead end. Exported as
 * the mutation's testable seam; other failures pass through untouched.
 */
const foldExpiredConsent = <E, R>(
  effect: Effect.Effect<OAuthConsentResult, E, R>
): Effect.Effect<OAuthConsentResult, E, R> =>
  Effect.catchIf(effect, isConsentNotFound, () =>
    Effect.succeed<OAuthConsentResult>({ status: 'error', message: EXPIRED_CONSENT_MESSAGE })
  )

/** Shared by the route `loader` and {@link useOAuthConsentQuery}. */
const oauthConsentQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<
  OAuthConsentResource,
  Error,
  OAuthConsentResource,
  readonly [string, string, string]
> =>
  queryOptions({
    queryKey: oauthConsentQueryKey(id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c['oauth-consent'].GetOAuthConsent({ path: { id } })
        )
      ),
  })

const useOAuthConsentQuery = (id: string): UseSuspenseQueryResult<OAuthConsentResource, Error> =>
  useSuspenseQuery(oauthConsentQueryOptions(useRunAuthed(), id))

/**
 * `ApproveOAuthConsent` / `DenyOAuthConsent`. Returns the resulting
 * decision.
 *
 * Like the device-consent mutation, the consent screen unmounts on
 * success (`onDone()` navigates to `/settings/gatekeeper`), so this
 * consent's own detail key is never re-read. Invalidate the grants list
 * root the user lands on so the new grant shows.
 */
const useOAuthConsentMutation = (): UseMutationResult<
  OAuthConsentResult,
  Error,
  | { readonly kind: 'approve'; readonly id: string; readonly payload: ApproveOAuthPayload }
  | { readonly kind: 'deny'; readonly id: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables) =>
      runAuthed(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          variables.kind === 'approve'
            ? c['oauth-consent'].ApproveOAuthConsent({
                path: { id: variables.id },
                payload: {
                  approvedScopes: [...variables.payload.approvedScopes],
                  patient: variables.payload.patient,
                  acknowledgedRegistration: variables.payload.acknowledgedRegistration,
                },
              })
            : c['oauth-consent'].DenyOAuthConsent({ path: { id: variables.id } })
        ).pipe(foldExpiredConsent)
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GRANTS_QUERY_KEY })
    },
  })
}

export {
  foldExpiredConsent,
  oauthConsentQueryOptions,
  useOAuthConsentMutation,
  useOAuthConsentQuery,
}
export type { ApproveOAuthPayload, OAuthConsentResource, OAuthConsentResult }
