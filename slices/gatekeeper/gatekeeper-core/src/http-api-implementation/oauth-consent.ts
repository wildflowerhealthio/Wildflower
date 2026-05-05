import { HttpApiBuilder } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { DateTime, Effect } from 'effect'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import {
  approveAuthorizationRequest,
  denyAuthorizationRequest,
} from '../contexts/oauth-consent-decisions.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { AuthorizationRequests, Grants } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(GatekeeperApi, 'oauth-consent', (handlers) =>
  handlers
    .handle('GetOAuthConsent', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore

        const request = store.query(AuthorizationRequests.queries.byId$(id))
        if (
          request == null ||
          request.flow !== 'authorization_code' ||
          request.redirectUri == null
        ) {
          return yield* Effect.fail({
            error: 'OAuthConsentNotFound' as const,
            id,
          })
        }

        return {
          id,
          clientId: request.clientId,
          scopes: request.requestedScopes,
          redirectUri: request.redirectUri,
          preApprovedScopes: request.preApprovedScopes ?? [],
          patient: request.patient ?? null,
        }
      })
    )
    .handle('ApproveOAuthConsent', ({ path: { id }, payload }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const pending = store.query(AuthorizationRequests.queries.byId$(id))
        if (
          pending == null ||
          pending.flow !== 'authorization_code' ||
          pending.redirectUri == null
        ) {
          return yield* Effect.fail({
            error: 'OAuthConsentNotFound' as const,
            id,
          })
        }
        const redirect = yield* approveAuthorizationRequest(
          id,
          [...payload.approvedScopes],
          payload.patient ?? undefined
        )
        if (redirect == null) {
          return yield* Effect.fail({
            error: 'OAuthConsentNotFound' as const,
            id,
          })
        }
        const grantedAt = yield* DateTime.now
        const existingGrant = store.query(
          Grants.queries.byClientIdAndRedirectUri$(pending.clientId, pending.redirectUri)
        )
        if (existingGrant == null) {
          store.commit(
            Grants.events.grantCreated({
              id: nanoid(),
              clientId: pending.clientId,
              scopes: payload.approvedScopes,
              redirectUri: pending.redirectUri,
              grantedAt,
              patient: payload.patient ?? null,
            })
          )
        } else {
          store.commit(
            Grants.events.grantUpdated({
              id: existingGrant.id,
              scopes: payload.approvedScopes,
              grantedAt,
              patient: payload.patient ?? null,
            })
          )
        }
        return { status: 'approved' as const }
      })
    )
    .handle('DenyOAuthConsent', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const pending = store.query(AuthorizationRequests.queries.byId$(id))
        if (pending == null) {
          return yield* Effect.fail({
            error: 'OAuthConsentNotFound' as const,
            id,
          })
        }
        yield* denyAuthorizationRequest(id)
        return { status: 'denied' as const }
      })
    )
)

export { layer }
