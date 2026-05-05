import { HttpApiBuilder } from '@effect/platform'
import type { Schema } from 'effect'
import { Effect, pipe } from 'effect'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import type { DeviceConsentNotFoundSchema } from '../http-api-definition/devices.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { AuthorizationRequests, type AuthorizationRequestRow, Clients } from '../livestore/index.ts'

type DeviceConsentNotFound = Schema.Schema.Type<typeof DeviceConsentNotFoundSchema>

const getPendingDeviceCodeRequest = (
  userCode: string
): Effect.Effect<AuthorizationRequestRow, DeviceConsentNotFound, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const pending = store.query(AuthorizationRequests.queries.byUserCode$(userCode))
    if (pending == null || pending.grantType !== 'device_code' || pending.status !== 'pending') {
      return yield* Effect.fail({
        error: 'DeviceConsentNotFound' as const,
        userCode,
      })
    }
    return pending
  })

const denyPending = (
  pending: AuthorizationRequestRow
): Effect.Effect<{ readonly status: 'denied' }, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    store.commit(AuthorizationRequests.events.authorizationRequestDenied({ id: pending.id }))
    return { status: 'denied' as const }
  })

const layer = HttpApiBuilder.group(GatekeeperApi, 'devices', (handlers) =>
  handlers
    .handle('GetDeviceConsent', ({ path: { userCode } }) =>
      pipe(
        getPendingDeviceCodeRequest(userCode),
        Effect.flatMap((pending) =>
          Effect.gen(function* () {
            const store = yield* GatekeeperStore
            const client = store.query(Clients.queries.byId$(pending.clientId))
            return {
              userCode,
              clientId: pending.clientId,
              clientName: client?.name ?? pending.clientId,
              requestedScopes: pending.requestedScopes,
            }
          })
        )
      )
    )
    .handle('ApproveDeviceConsent', ({ path: { userCode }, payload }) =>
      pipe(
        getPendingDeviceCodeRequest(userCode),
        Effect.flatMap((pending) =>
          Effect.gen(function* () {
            const store = yield* GatekeeperStore
            const requestedScopes = new Set(pending.requestedScopes)
            const grantedScopes = payload.approvedScopes.filter((s) => requestedScopes.has(s))
            // Approving with an empty granted-scope set is semantically a
            // denial: the client would otherwise receive a token with
            // `scope=''` that grants nothing. Route through deny so the
            // caller sees `access_denied` on its next poll.
            if (grantedScopes.length === 0) {
              return yield* denyPending(pending)
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
      )
    )
    .handle('DenyDeviceConsent', ({ path: { userCode } }) =>
      pipe(getPendingDeviceCodeRequest(userCode), Effect.flatMap(denyPending))
    )
)

export { layer }
