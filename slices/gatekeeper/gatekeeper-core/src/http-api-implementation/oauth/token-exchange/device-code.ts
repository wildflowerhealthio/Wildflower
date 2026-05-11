import type { Schema } from 'effect'
import { DateTime, Duration, Effect, Match } from 'effect'
import type { Origin } from 'navigation-core'
import { GatekeeperStore } from '../../../contexts/gatekeeper-store.ts'
import type { DeviceCodePayload } from '../../../http-api-definition/oauth.ts'
import { OAuthError400Schema } from '../../../http-api-definition/oauth.ts'
import { AuthorizationRequest, type AuthorizationRequestRow } from '../../../livestore/index.ts'
import {
  DEVICE_CODE_POLL_INTERVAL,
  issueTokenResponse,
  type OAuthError400,
  type OAuthError401,
  type OAuthError500,
  requireValidClientForToken,
  type TokenResponse,
} from '../shared.ts'

type DeviceCodeExchange = Schema.Schema.Type<typeof DeviceCodePayload>

const getPendingDeviceCodeRequest = (
  deviceCode: string,
  clientId: string
): Effect.Effect<AuthorizationRequestRow, OAuthError400, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const pending = store.query(AuthorizationRequest.queries.byId$(deviceCode))
    if (pending == null || pending.grantType !== 'device_code' || pending.clientId !== clientId) {
      return yield* Effect.fail(
        OAuthError400Schema.make({
          error: 'invalid_grant',
          error_description: 'Unknown device_code',
        })
      )
    }
    return pending
  })

const requireDeviceCodeNotExpired = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, OAuthError400> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    if (DateTime.lessThan(pending.expiresAt, now)) {
      yield* Effect.fail(OAuthError400Schema.make({ error: 'expired_token' }))
    }
  })

const requireDevicePollIntervalElapsed = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, OAuthError400> =>
  Effect.gen(function* () {
    if (pending.lastPolledAt == null) return
    const now = yield* DateTime.now
    const sinceLastPoll = Duration.millis(DateTime.distance(pending.lastPolledAt, now))
    if (Duration.lessThan(sinceLastPoll, DEVICE_CODE_POLL_INTERVAL)) {
      yield* Effect.fail(OAuthError400Schema.make({ error: 'slow_down' }))
    }
  })

const recordDevicePoll = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const polledAt = yield* DateTime.now
    store.commit(
      AuthorizationRequest.events.deviceAuthorizationPolled({ id: pending.id, polledAt })
    )
  })

const requireDeviceConsentResolved = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, OAuthError400> =>
  Match.value(pending.status).pipe(
    Match.when('approved', () => Effect.void),
    Match.when('pending', () =>
      Effect.fail(OAuthError400Schema.make({ error: 'authorization_pending' }))
    ),
    Match.when('denied', () => Effect.fail(OAuthError400Schema.make({ error: 'access_denied' }))),
    Match.when('expired', () => Effect.fail(OAuthError400Schema.make({ error: 'expired_token' }))),
    Match.orElse(() =>
      Effect.fail(
        OAuthError400Schema.make({
          error: 'invalid_grant',
          error_description: 'Unsupported status',
        })
      )
    )
  )

const consumeDeviceCode = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    // device_code is single-use per RFC 8628 §3.4: mark expired so a
    // second poll returns expired_token rather than re-issuing a token.
    store.commit(AuthorizationRequest.events.authorizationRequestExpired({ id: pending.id }))
  })

const handleDeviceCodeTokenExchange = (
  payload: DeviceCodeExchange
): Effect.Effect<
  TokenResponse,
  OAuthError400 | OAuthError401 | OAuthError500,
  GatekeeperStore | Origin
> =>
  Effect.gen(function* () {
    yield* requireValidClientForToken(payload.client_id, payload.client_secret)
    const pending = yield* getPendingDeviceCodeRequest(payload.device_code, payload.client_id)
    yield* requireDeviceCodeNotExpired(pending)
    // `slow_down` is a back-pressure signal for clients still waiting on
    // Owner consent — it only applies while the row is `pending`. Once
    // the row is `approved` (and we're about to consume) or has reached
    // a terminal status (`denied` / `expired`), report the real
    // disposition instead so the client doesn't busy-wait on a row that
    // has already been resolved.
    if (pending.status === 'pending') {
      yield* requireDevicePollIntervalElapsed(pending)
      yield* recordDevicePoll(pending)
    }
    yield* requireDeviceConsentResolved(pending)
    yield* consumeDeviceCode(pending)
    return yield* issueTokenResponse({
      clientId: pending.clientId,
      grantedScopes: pending.grantedScopes ?? [],
      patient: pending.patient,
    })
  })

export { handleDeviceCodeTokenExchange }
