import { HttpApiBuilder } from '@effect/platform'
import { Effect, pipe, type Schema } from 'effect'
import type { DeviceConsentNotFoundSchema } from '../http-api-definition/devices.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import {
  AuthorizationRequest,
  type AuthorizationRequestRow,
  Client,
  GatekeeperStore,
} from '../livestore/index.ts'
type DeviceConsentNotFound = Schema.Schema.Type<typeof DeviceConsentNotFoundSchema>

const getPendingDeviceCodeRequest = (
  userCode: string
): Effect.Effect<AuthorizationRequestRow, DeviceConsentNotFound, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const pending = store.query(AuthorizationRequest.queries.byUserCode$(userCode))
    if (pending == null || pending.grantType !== 'device_code' || pending.status !== 'pending') {
      return yield* Effect.fail({
        error: 'DeviceConsentNotFound' as const,
        userCode,
      })
    }
    return pending
  })

const buildDeviceConsentResponse = (
  pending: AuthorizationRequestRow,
  userCode: string
): Effect.Effect<
  {
    readonly userCode: string
    readonly clientId: string
    readonly clientName: string
    readonly requestedScopes: ReadonlyArray<string>
  },
  never,
  GatekeeperStore
> =>
  GatekeeperStore.pipe(
    Effect.map((store) => {
      const client = store.query(Client.queries.byId$(pending.clientId))
      return {
        userCode,
        clientId: pending.clientId,
        clientName: client?.name ?? pending.clientId,
        requestedScopes: pending.requestedScopes,
      }
    })
  )

const denyPending = (
  pending: AuthorizationRequestRow
): Effect.Effect<{ readonly status: 'denied' }, never, GatekeeperStore> =>
  GatekeeperStore.pipe(
    Effect.map((store) => {
      store.commit(AuthorizationRequest.events.authorizationRequestDenied({ id: pending.id }))
      return { status: 'denied' as const }
    })
  )

const commitApproval = (
  pending: AuthorizationRequestRow,
  grantedScopes: ReadonlyArray<string>
): Effect.Effect<{ readonly status: 'approved' }, never, GatekeeperStore> =>
  GatekeeperStore.pipe(
    Effect.map((store) => {
      store.commit(
        AuthorizationRequest.events.authorizationRequestApproved({
          id: pending.id,
          grantedScopes,
          patient: null,
        })
      )
      return { status: 'approved' as const }
    })
  )

const filterToRequestedScopes = (
  pending: AuthorizationRequestRow,
  approvedScopes: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const requestedScopes = new Set(pending.requestedScopes)
  return approvedScopes.filter((s) => requestedScopes.has(s))
}

const approvePendingForRequestedScopes = (
  pending: AuthorizationRequestRow,
  approvedScopes: ReadonlyArray<string>
): Effect.Effect<
  { readonly status: 'approved' } | { readonly status: 'denied' },
  never,
  GatekeeperStore
> => {
  const grantedScopes = filterToRequestedScopes(pending, approvedScopes)
  // Approving with an empty granted-scope set is semantically a
  // denial: the client would otherwise receive a token with
  // `scope=''` that grants nothing. Route through deny so the
  // caller sees `access_denied` on its next poll.
  if (grantedScopes.length === 0) return denyPending(pending)
  return commitApproval(pending, grantedScopes)
}

const layer = HttpApiBuilder.group(GatekeeperApi, 'devices', (handlers) =>
  handlers
    .handle('GetDeviceConsent', ({ path: { userCode } }) =>
      pipe(
        getPendingDeviceCodeRequest(userCode),
        Effect.flatMap((pending) => buildDeviceConsentResponse(pending, userCode))
      )
    )
    .handle('ApproveDeviceConsent', ({ path: { userCode }, payload }) =>
      pipe(
        getPendingDeviceCodeRequest(userCode),
        Effect.flatMap((pending) =>
          approvePendingForRequestedScopes(pending, payload.approvedScopes)
        )
      )
    )
    .handle('DenyDeviceConsent', ({ path: { userCode } }) =>
      pipe(getPendingDeviceCodeRequest(userCode), Effect.flatMap(denyPending))
    )
)

export { layer }
