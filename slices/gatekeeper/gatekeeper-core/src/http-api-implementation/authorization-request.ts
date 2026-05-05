import { HttpApiBuilder } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { DateTime, Effect } from 'effect'
import {
  approveAuthRequest,
  approvePinAuth,
  declineAuthRequest,
  declinePinAuth,
} from '../contexts/AuthListeners.ts'
import { AuthStore } from '../contexts/AuthStore.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import { AuthCodes, Clients, ClientIdSchema, PinAuths } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(AuthApi, 'authorization-request', (handlers) =>
  handlers
    .handle('GetAuthorizationRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore

        const oauth = store.query(AuthCodes.queries.byCode$(id))
        if (oauth != null) {
          return {
            _tag: 'oauth2' as const,
            id,
            clientId: oauth.clientId,
            scopes: oauth.scope.split(' ').filter(Boolean),
            redirectUri: oauth.redirectUri,
            preApprovedScopes: oauth.preApprovedScopes ?? [],
            patient: oauth.patient ?? null,
          }
        }

        const pin = store.query(PinAuths.queries.byId$(id))
        if (pin != null) {
          return {
            _tag: 'pin_cookie' as const,
            id,
            returnTo: pin.returnTo,
            expiresAt: pin.exp,
          }
        }

        return yield* Effect.fail({
          error: 'AuthorizationRequestNotFound' as const,
          id,
        })
      })
    )
    .handle('PatchAuthorizationRequest', ({ path: { id }, payload }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore

        if (payload._tag === 'oauth2') {
          const pending = store.query(AuthCodes.queries.byCode$(id))
          if (pending == null) {
            return yield* Effect.fail({
              error: 'AuthorizationRequestNotFound' as const,
              id,
            })
          }
          if (payload.status === 'approved') {
            approveAuthRequest(store, id, [...payload.approvedScopes], payload.patient ?? undefined)
            store.commit(
              Clients.events.clientApproved({
                id: ClientIdSchema.make(nanoid()),
                clientId: pending.clientId,
                type: 'oauth',
                scopes: payload.approvedScopes,
                redirectUri: pending.redirectUri,
                approvedAt: DateTime.unsafeNow(),
                label: pending.clientId,
                patient: payload.patient ?? null,
              })
            )
            return { status: 'approved' as const }
          }
          declineAuthRequest(store, id)
          return { status: 'denied' as const }
        }

        const pin = store.query(PinAuths.queries.byId$(id))
        if (pin == null) {
          return yield* Effect.fail({
            error: 'AuthorizationRequestNotFound' as const,
            id,
          })
        }
        if (payload.status === 'approved') {
          const ok = approvePinAuth(store, id, payload.pin, payload.duration)
          if (!ok) return { status: 'invalid_pin' as const }
          return { status: 'approved' as const }
        }
        declinePinAuth(store, id)
        return { status: 'denied' as const }
      })
    )
)

export { layer }
