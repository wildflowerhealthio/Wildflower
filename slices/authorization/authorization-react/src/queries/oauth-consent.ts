import { type UseMutationOptions } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import type { OAuthConsent } from '@wildflowerhealthio/authorization-core/http-api-definition'
import { Effect, type Schema } from 'effect'

import type { RunAuthed } from '../router-context.ts'

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
  readonly acknowledgedRegistrationChange: boolean
}

/** The Owner's decision on an OAuth consent: approve with a payload, or deny. */
type OAuthConsentDecision =
  | { readonly kind: 'approve'; readonly id: string; readonly payload: ApproveOAuthPayload }
  | { readonly kind: 'deny'; readonly id: string }

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

/**
 * `ApproveOAuthConsent` / `DenyOAuthConsent` over `runAuthed`, as mutation
 * options: the decision's `mutationFn`, which resolves to the resulting
 * decision. The authorization server's consent card (`authorization-server-web`)
 * runs it on the browser session.
 */
const oauthConsentMutationOptions = (
  runAuthed: RunAuthed
): UseMutationOptions<OAuthConsentResult, Error, OAuthConsentDecision> => ({
  mutationFn: (decision) =>
    runAuthed(
      Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
        decision.kind === 'approve'
          ? c['oauth-consent'].ApproveOAuthConsent({
              path: { id: decision.id },
              payload: {
                approvedScopes: [...decision.payload.approvedScopes],
                patient: decision.payload.patient,
                acknowledgedRegistrationChange: decision.payload.acknowledgedRegistrationChange,
              },
            })
          : c['oauth-consent'].DenyOAuthConsent({ path: { id: decision.id } })
      ).pipe(foldExpiredConsent)
    ),
})

export { foldExpiredConsent, oauthConsentMutationOptions }
export type { ApproveOAuthPayload, OAuthConsentDecision, OAuthConsentResource, OAuthConsentResult }
