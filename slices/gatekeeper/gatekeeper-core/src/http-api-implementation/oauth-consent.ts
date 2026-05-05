import { HttpApiBuilder } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { DateTime, Effect } from 'effect'
import {
  approveAuthorizationRequest,
  denyAuthorizationRequest,
} from '../contexts/consent-decisions.ts'
import { GatekeeperStore } from '../contexts/GatekeeperStore.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { AuthorizationRequests, Grants, GrantIdSchema } from '../livestore/index.ts'

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
        approveAuthorizationRequest(
          store,
          id,
          [...payload.approvedScopes],
          payload.patient ?? undefined
        )
        store.commit(
          Grants.events.grantUpserted({
            id: GrantIdSchema.make(nanoid()),
            clientId: pending.clientId,
            scopes: payload.approvedScopes,
            redirectUri: pending.redirectUri,
            grantedAt: DateTime.unsafeNow(),
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
        denyAuthorizationRequest(store, id)
        return { status: 'denied' as const }
      })
    )
)

export { layer }
