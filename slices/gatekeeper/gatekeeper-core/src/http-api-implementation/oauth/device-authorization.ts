import type { Schema } from 'effect'
import { DateTime, Duration, Effect } from 'effect'
import type { Origin } from 'kitchen-sink'
import { CryptoRandom } from 'kitchen-sink/crypto-random'
import { GatekeeperStore } from '../../contexts/gatekeeper-store.ts'
import {
  type DeviceAuthorizationPayloadSchema,
  DeviceAuthorizationResponseSchema,
  OAuthError400Schema,
  OAuthError401Schema,
} from '../../http-api-definition/oauth.ts'
import { generateUserCode } from '../../internal/user-code.ts'
import { AuthorizationRequest, Client, type ClientRow } from '../../livestore/index.ts'
import * as GatekeeperPaths from '../../page-paths.ts'
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
    const client = store.query(Client.queries.byId$(clientId))
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
): Effect.Effect<string, never, CryptoRandom> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = yield* generateUserCode
      const existing = store.query(AuthorizationRequest.queries.byUserCode$(candidate))
      if (existing == null || existing.status !== 'pending') return candidate
    }
    return yield* Effect.die(new Error('Could not generate a unique user_code after 10 attempts'))
  })

const startDeviceAuthorizationRequest = (input: {
  clientId: string
  requestedScopes: ReadonlyArray<string>
}): Effect.Effect<{ id: string; userCode: string }, never, GatekeeperStore | CryptoRandom> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const cryptoRandom = yield* CryptoRandom
    const id = yield* cryptoRandom.nextUuid
    const userCode = yield* generateUniqueUserCode(store)
    const requestedAt = yield* DateTime.now
    const expiresAt = DateTime.addDuration(requestedAt, DEVICE_AUTHORIZATION_TTL)
    store.commit(
      AuthorizationRequest.events.deviceAuthorizationRequestStarted({
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

const handleDeviceAuthorization = (
  payload: DeviceAuthorizationPayload
): Effect.Effect<
  DeviceAuthorizationResponse,
  OAuthError400 | OAuthError401,
  GatekeeperStore | Origin | CryptoRandom
> => {
  const requestedScopes = (payload.scope ?? '').split(' ').filter(Boolean)
  return Effect.gen(function* () {
    yield* requireValidDeviceAuthorizationClient(payload.client_id, requestedScopes)
    const { id, userCode } = yield* startDeviceAuthorizationRequest({
      clientId: payload.client_id,
      requestedScopes,
    })
    const verificationUri = yield* GatekeeperPaths.deviceEntryUrl()
    const verificationUriComplete = yield* GatekeeperPaths.deviceEntryUrlWithCode(userCode)
    return DeviceAuthorizationResponseSchema.make({
      device_code: id,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      expires_in: Math.floor(Duration.toSeconds(DEVICE_AUTHORIZATION_TTL)),
      interval: Math.floor(Duration.toSeconds(DEVICE_CODE_POLL_INTERVAL)),
    })
  })
}

export { handleDeviceAuthorization }
