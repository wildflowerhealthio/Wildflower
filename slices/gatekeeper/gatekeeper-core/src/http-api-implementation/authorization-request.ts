import { HttpApiBuilder } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { DateTime, Effect } from 'effect'
import {
  approveAuthRequest,
  approvePinAuth,
  declineAuthRequest,
  declinePinAuth,
} from '../contexts/AuthListeners.ts'
import { AuthState } from '../contexts/AuthState.ts'
import { AuthStore } from '../contexts/AuthStore.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import { ApprovedApps, ApprovedAppIdSchema } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(AuthApi, 'authorization-request', (handlers) =>
  handlers
    .handle('GetAuthorizationRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const state = yield* AuthState

        const oauth = state.pendingAuths.get(id)
        if (oauth !== undefined) {
          return {
            _tag: 'oauth2' as const,
            id,
            clientId: oauth.client_id,
            scopes: oauth.scope.split(' ').filter(Boolean),
            redirectUri: oauth.redirect_uri,
            preApprovedScopes: oauth.preApprovedScopes ?? [],
            patient: oauth.patient ?? null,
          }
        }

        const pin = state.pinAuths.get(id)
        if (pin !== undefined) {
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
        const state = yield* AuthState
        const store = yield* AuthStore

        if (payload._tag === 'oauth2') {
          const pending = state.pendingAuths.get(id)
          if (pending === undefined) {
            return yield* Effect.fail({
              error: 'AuthorizationRequestNotFound' as const,
              id,
            })
          }
          if (payload.status === 'approved') {
            approveAuthRequest(id, [...payload.approvedScopes], payload.patient ?? undefined)
            store.commit(
              ApprovedApps.events.appApproved({
                id: ApprovedAppIdSchema.make(nanoid()),
                clientId: pending.client_id,
                type: 'oauth',
                scopes: payload.approvedScopes,
                redirectUri: pending.redirect_uri,
                approvedAt: DateTime.unsafeNow(),
                label: pending.client_id,
                patient: payload.patient ?? null,
              })
            )
            return { status: 'approved' as const }
          }
          declineAuthRequest(id)
          return { status: 'denied' as const }
        }

        const pin = state.pinAuths.get(id)
        if (pin === undefined) {
          return yield* Effect.fail({
            error: 'AuthorizationRequestNotFound' as const,
            id,
          })
        }
        if (payload.status === 'approved') {
          const ok = approvePinAuth(id, payload.pin, payload.duration)
          if (!ok) return { status: 'invalid_pin' as const }
          return { status: 'approved' as const }
        }
        declinePinAuth(id)
        return { status: 'denied' as const }
      })
    )
)

export { layer }
