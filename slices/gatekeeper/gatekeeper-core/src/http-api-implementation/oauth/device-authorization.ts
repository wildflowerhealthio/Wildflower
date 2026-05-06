import type { Schema } from 'effect'
import { DateTime, Duration, Effect } from 'effect'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../../contexts/gatekeeper-store.ts'
import {
  type DeviceAuthorizationPayloadSchema,
  DeviceAuthorizationResponseSchema,
  OAuthError400Schema,
  OAuthError401Schema,
} from '../../http-api-definition/oauth.ts'
import { type CryptoRandomByte, generateUserCode } from '../../internal/user-code.ts'
import { AuthorizationRequests, Clients, type ClientRow } from '../../livestore/index.ts'
import { DEVICE_CODE_POLL_INTERVAL, type OAuthError400, type OAuthError401 } from './shared.ts'

type DeviceAuthorizationPayload = Schema.Schema.Type<typeof DeviceAuthorizationPayloadSchema>
type DeviceAuthorizationResponse = Schema.Schema.Type<typeof DeviceAuthorizationResponseSchema>

const DEVICE_AUTHORIZATION_TTL: Duration.Duration = Duration.minutes(5)

// Device-flow client lookup: returns the row narrowed to "enabled"
// (`disabledAt: null`). Errors are 401-shaped because device-auth speaks
// JSON, not HTML.
const getEnabledClientForDeviceAuth = (
  clientId: string
): Effect.Effect<ClientRow & { disabledAt: null }, OAuthError401, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const client = store.query(Clients.queries.byId$(clientId))
    if (client == null || client.disabledAt != null) {
      return yield* Effect.fail(
        OAuthError401Schema.make({
          error: 'invalid_client',
          error_description: 'Unknown or disabled client_id',
        })
      )
    }
    return { ...client, disabledAt: null }
  })

const requireClientAllowsRequesterScopesForDeviceAuth = (
  client: ClientRow,
  requestedScopes: ReadonlyArray<string>
): Effect.Effect<void, OAuthError400> => {
  const allowed = new Set(client.allowedScopes)
  if (requestedScopes.every((s) => allowed.has(s))) return Effect.void
  return Effect.fail(
    OAuthError400Schema.make({
      error: 'invalid_scope',
      error_description: 'Scope not allowed for client',
    })
  )
}

const requireValidDeviceAuthorizationClient = (
  clientId: string,
  requestedScopes: ReadonlyArray<string>
): Effect.Effect<ClientRow, OAuthError400 | OAuthError401, GatekeeperStore> =>
  Effect.gen(function* () {
    const client = yield* getEnabledClientForDeviceAuth(clientId)
    yield* requireClientAllowsRequesterScopesForDeviceAuth(client, requestedScopes)
    return client
  })

const generateUniqueUserCode = (
  store: typeof GatekeeperStore.Service
): Effect.Effect<string, never, CryptoRandomByte> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = yield* generateUserCode
      const existing = store.query(AuthorizationRequests.queries.byUserCode$(candidate))
      if (existing == null || existing.status !== 'pending') return candidate
    }
    return yield* Effect.die(new Error('Could not generate a unique user_code after 10 attempts'))
  })

const startDeviceAuthorizationRequest = (input: {
  clientId: string
  requestedScopes: ReadonlyArray<string>
}): Effect.Effect<{ id: string; userCode: string }, never, GatekeeperStore | CryptoRandomByte> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const id = crypto.randomUUID()
    const userCode = yield* generateUniqueUserCode(store)
    const requestedAt = yield* DateTime.now
    const expiresAt = DateTime.addDuration(requestedAt, DEVICE_AUTHORIZATION_TTL)
    store.commit(
      AuthorizationRequests.events.deviceAuthorizationRequestStarted({
        id,
        clientId: input.clientId,
        requestedScopes: input.requestedScopes,
        userCode,
        requestedAt,
        expiresAt,
      })
    )
    return { id, userCode }
  })

const buildDeviceAuthorizationResponse = (input: {
  id: string
  userCode: string
  origin: string
}): DeviceAuthorizationResponse =>
  DeviceAuthorizationResponseSchema.make({
    device_code: input.id,
    user_code: input.userCode,
    verification_uri: `${input.origin}/access/devices`,
    verification_uri_complete: `${input.origin}/access/devices?user_code=${input.userCode}`,
    expires_in: Math.floor(Duration.toMillis(DEVICE_AUTHORIZATION_TTL) / 1000),
    interval: Math.floor(Duration.toMillis(DEVICE_CODE_POLL_INTERVAL) / 1000),
  })

const handleDeviceAuthorization = (
  payload: DeviceAuthorizationPayload
): Effect.Effect<
  DeviceAuthorizationResponse,
  OAuthError400 | OAuthError401,
  GatekeeperStore | Origin | CryptoRandomByte
> => {
  const requestedScopes = (payload.scope ?? '').split(' ').filter(Boolean)
  return Effect.gen(function* () {
    yield* requireValidDeviceAuthorizationClient(payload.client_id, requestedScopes)
    const { id, userCode } = yield* startDeviceAuthorizationRequest({
      clientId: payload.client_id,
      requestedScopes,
    })
    const origin = yield* Origin
    return buildDeviceAuthorizationResponse({ id, userCode, origin })
  })
}

export { handleDeviceAuthorization }
