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
        if (request == null) {
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
        if (pending == null) {
          return yield* Effect.fail({
            error: 'OAuthConsentNotFound' as const,
            id,
          })
        }
        yield* approveAuthorizationRequest(
          id,
          [...payload.approvedScopes],
          payload.patient ?? undefined
        )
        const grantedAt = yield* DateTime.now
        store.commit(
          Grants.events.grantUpserted({
            id: nanoid(),
            clientId: pending.clientId,
            scopes: payload.approvedScopes,
            redirectUri: pending.redirectUri,
            grantedAt,
            label: pending.clientId,
            patient: payload.patient ?? null,
          })
        )
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
