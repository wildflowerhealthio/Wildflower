import { HttpApiBuilder } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { DateTime, Effect, pipe, type Schema } from 'effect'
import {
  approveAuthorizationRequest,
  denyAuthorizationRequest,
} from '../contexts/oauth-consent-decisions.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import type { OAuthConsentNotFoundSchema } from '../http-api-definition/oauth-consent.ts'
import {
  AuthorizationRequest,
  type AuthorizationRequestRow,
  GatekeeperStore,
  Grant,
} from '../livestore/index.ts'
type OAuthConsentNotFound = Schema.Schema.Type<typeof OAuthConsentNotFoundSchema>

const oauthConsentNotFound = (id: string): OAuthConsentNotFound => ({
  error: 'OAuthConsentNotFound' as const,
  id,
})

// Code-flow consent rows: must exist, must be the authorization_code
// grant type, and must carry the redirect URI the request started with.
// Returning a narrowed row (with `redirectUri: string`, not nullable)
// removes the null-narrowing dance from each handler.
const getPendingCodeFlowRequest = (
  id: string
): Effect.Effect<
  AuthorizationRequestRow & { redirectUri: string },
  OAuthConsentNotFound,
  GatekeeperStore
> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const request = store.query(AuthorizationRequest.queries.byId$(id))
    if (
      request == null ||
      request.status !== 'pending' ||
      request.grantType !== 'authorization_code' ||
      request.redirectUri == null
    ) {
      return yield* Effect.fail(oauthConsentNotFound(id))
    }
    return { ...request, redirectUri: request.redirectUri }
  })

const upsertGrant = (input: {
  clientId: string
  redirectUri: string
  scopes: ReadonlyArray<string>
  patient: string | null
}): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const grantedAt = yield* DateTime.now
    const existing = store.query(
      Grant.queries.byClientIdAndRedirectUri$(input.clientId, input.redirectUri)
    )
    if (existing == null) {
      store.commit(
        Grant.events.grantCreated({
          id: nanoid(),
          clientId: input.clientId,
          scopes: input.scopes,
          redirectUri: input.redirectUri,
          grantedAt,
          patient: input.patient,
        })
      )
    } else {
      store.commit(
        Grant.events.grantUpdated({
          id: existing.id,
          scopes: input.scopes,
          grantedAt,
          patient: input.patient,
        })
      )
    }
  })

const layer = HttpApiBuilder.group(GatekeeperApi, 'oauth-consent', (handlers) =>
  handlers
    .handle('GetOAuthConsent', ({ path: { id } }) =>
      pipe(
        getPendingCodeFlowRequest(id),
        Effect.map((request) => ({
          id,
          clientId: request.clientId,
          scopes: request.requestedScopes,
          redirectUri: request.redirectUri,
          preApprovedScopes: request.preApprovedScopes ?? [],
          patient: request.patient ?? null,
        }))
      )
    )
    .handle('ApproveOAuthConsent', ({ path: { id }, payload }) =>
      pipe(
        getPendingCodeFlowRequest(id),
        Effect.flatMap((pending) =>
          Effect.gen(function* () {
            const redirect = yield* approveAuthorizationRequest(
              id,
              [...payload.approvedScopes],
              payload.patient ?? undefined
            )
            if (redirect == null) {
              return yield* Effect.fail(oauthConsentNotFound(id))
            }
            yield* upsertGrant({
              clientId: pending.clientId,
              redirectUri: pending.redirectUri,
              scopes: payload.approvedScopes,
              patient: payload.patient ?? null,
            })
            return { status: 'approved' as const }
          })
        )
      )
    )
    .handle('DenyOAuthConsent', ({ path: { id } }) =>
      pipe(
        getPendingCodeFlowRequest(id),
        Effect.flatMap(() => denyAuthorizationRequest(id)),
        Effect.as({ status: 'denied' as const })
      )
    )
)

export { layer }
