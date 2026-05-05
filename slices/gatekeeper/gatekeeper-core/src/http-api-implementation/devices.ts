import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { AuthorizationRequests, Clients } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(GatekeeperApi, 'devices', (handlers) =>
  handlers
    .handle('GetDeviceConsent', ({ path: { userCode } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const pending = store.query(AuthorizationRequests.queries.byUserCode$(userCode))
        if (pending == null || pending.flow !== 'device_code' || pending.status !== 'pending') {
          return yield* Effect.fail({
            error: 'DeviceConsentNotFound' as const,
            userCode,
          })
        }
        const client = store.query(Clients.queries.byId$(pending.clientId))
        return {
          userCode,
          clientId: pending.clientId,
          clientName: client?.name ?? pending.clientId,
          requestedScopes: pending.requestedScopes,
        }
      })
    )
    .handle('ApproveDeviceConsent', ({ path: { userCode }, payload }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const pending = store.query(AuthorizationRequests.queries.byUserCode$(userCode))
        if (pending == null || pending.flow !== 'device_code' || pending.status !== 'pending') {
          return yield* Effect.fail({
            error: 'DeviceConsentNotFound' as const,
            userCode,
          })
        }
        const requestedScopeSet = new Set(pending.requestedScopes)
        const grantedScopes = payload.approvedScopes.filter((s) => requestedScopeSet.has(s))
        // Approving with empty granted scopes is semantically a denial:
        // the OAuth client would otherwise receive a token with `scope=''`
        // that grants nothing. Route through the deny path so the caller
        // sees `access_denied` on its next poll.
        if (grantedScopes.length === 0) {
          store.commit(AuthorizationRequests.events.authorizationRequestDenied({ id: pending.id }))
          return { status: 'denied' as const }
        }
        store.commit(
          AuthorizationRequests.events.authorizationRequestApproved({
            id: pending.id,
            grantedScopes,
            patient: null,
          })
        )
        return { status: 'approved' as const }
      })
    )
    .handle('DenyDeviceConsent', ({ path: { userCode } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const pending = store.query(AuthorizationRequests.queries.byUserCode$(userCode))
        if (pending == null || pending.flow !== 'device_code' || pending.status !== 'pending') {
          return yield* Effect.fail({
            error: 'DeviceConsentNotFound' as const,
            userCode,
          })
        }
        store.commit(AuthorizationRequests.events.authorizationRequestDenied({ id: pending.id }))
        return { status: 'denied' as const }
      })
    )
)

export { layer }
