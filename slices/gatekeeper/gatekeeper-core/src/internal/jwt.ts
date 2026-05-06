import { HttpApiError } from '@effect/platform'
import { DateTime, type Duration, Effect, pipe } from 'effect'
import type { UnknownException } from 'effect/Cause'
import type * as jose from 'jose'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import { Clients, type SigningKey, SigningKeys } from '../livestore/index.ts'

type VerifiedPayload = {
  iss: string
  sub: string
  aud: string | ReadonlyArray<string>
  exp?: number
  iat?: number
  scope?: string
  patient?: string
  [key: string]: unknown
}

const unauthorized = (): HttpApiError.Unauthorized => new HttpApiError.Unauthorized()

// Try each signing key in turn; first one whose `jose.jwtVerify`
// succeeds wins. Verification options (`expectedIssuer`,
// `acceptedAudiences`) are validated by `jose` itself, so a key that
// signed a token with the wrong iss/aud also fails here.
const verifyAgainstAnyKey = (
  token: string,
  keys: ReadonlyArray<SigningKey>,
  options: { expectedIssuer: string; acceptedAudiences: ReadonlyArray<string> }
): Effect.Effect<jose.JWTVerifyResult<jose.JWTPayload>, HttpApiError.Unauthorized> =>
  pipe(
    keys.map((jwk) =>
      Effect.tryPromise(() => jwk.verifyJwt(token, options)).pipe(Effect.mapError(unauthorized))
    ),
    Effect.firstSuccessOf,
    Effect.catchAll(() => Effect.fail(unauthorized()))
  )

// `jose.jwtVerify` already enforces iss/aud/exp when we pass the
// options, but we re-check in the wrapper too. Belt and braces: any
// custom `SigningKey` impl that bypasses jose (e.g. a test stub) still
// gets the same gating, so wrapper-level invariants don't depend on
// what the verifier returns.
const requireIssuerMatches = (
  payload: jose.JWTPayload,
  expectedIssuer: string
): Effect.Effect<void, HttpApiError.Unauthorized> =>
  payload.iss === expectedIssuer ? Effect.void : Effect.fail(unauthorized())

const requireAudienceAccepted = (
  payload: jose.JWTPayload,
  acceptedAudiences: ReadonlyArray<string>
): Effect.Effect<void, HttpApiError.Unauthorized> => {
  const audClaim = payload.aud
  const presented = Array.isArray(audClaim)
    ? audClaim
    : typeof audClaim === 'string'
      ? [audClaim]
      : []
  return presented.some((a) => acceptedAudiences.includes(a))
    ? Effect.void
    : Effect.fail(unauthorized())
}

const requireNotExpired = (
  payload: jose.JWTPayload
): Effect.Effect<void, HttpApiError.Unauthorized> =>
  Effect.gen(function* () {
    if (typeof payload.exp !== 'number') return
    const nowDt = yield* DateTime.now
    const nowSeconds = Math.floor(DateTime.toEpochMillis(nowDt) / 1000)
    if (payload.exp <= nowSeconds) {
      yield* Effect.fail(unauthorized())
    }
  })

const requireRegisteredEnabledSubject = (
  payload: jose.JWTPayload
): Effect.Effect<string, HttpApiError.Unauthorized, GatekeeperStore> =>
  Effect.gen(function* () {
    if (typeof payload.sub !== 'string') {
      return yield* Effect.fail(unauthorized())
    }
    const store = yield* GatekeeperStore
    const client = store.query(Clients.queries.byId$(payload.sub))
    if (client == null || client.disabledAt != null) {
      return yield* Effect.fail(unauthorized())
    }
    return payload.sub
  })

const verifyJwt = (
  token: string
): Effect.Effect<VerifiedPayload, HttpApiError.Unauthorized, GatekeeperStore | Origin> =>
  Effect.gen(function* () {
    if (token.trim().length === 0) {
      return yield* Effect.fail(unauthorized())
    }
    const store = yield* GatekeeperStore
    const origin = yield* Origin
    const signingKeys = store.query(SigningKeys.queries.all$)
    if (signingKeys.length === 0) {
      return yield* Effect.fail(unauthorized())
    }
    const expectedIssuer = origin
    const acceptedAudiences: ReadonlyArray<string> = [`${origin}/fhir`, origin]
    const verified = yield* verifyAgainstAnyKey(token, signingKeys, {
      expectedIssuer,
      acceptedAudiences,
    })
    yield* requireIssuerMatches(verified.payload, expectedIssuer)
    yield* requireAudienceAccepted(verified.payload, acceptedAudiences)
    yield* requireNotExpired(verified.payload)
    yield* requireRegisteredEnabledSubject(verified.payload)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return verified.payload as VerifiedPayload
  })

const signJwt = (
  jwk: SigningKey,
  payload: jose.JWTPayload
): Effect.Effect<string, UnknownException> => Effect.tryPromise(() => jwk.signJwt(payload))

type MintAccessTokenPayload = {
  clientId: string
  scope: ReadonlyArray<string>
  ttl: Duration.Duration
  audience?: string
  patient?: string | null
}

const mintAccessToken = (
  signingKey: SigningKey,
  origin: string,
  { clientId, scope, ttl, audience, patient }: MintAccessTokenPayload
): Effect.Effect<string, UnknownException> =>
  Effect.gen(function* () {
    const nowDt = yield* DateTime.now
    const expDt = DateTime.addDuration(nowDt, ttl)
    const payload: jose.JWTPayload = {
      iss: origin,
      sub: clientId,
      aud: audience ?? origin,
      exp: Math.floor(DateTime.toEpochMillis(expDt) / 1000),
      iat: Math.floor(DateTime.toEpochMillis(nowDt) / 1000),
      scope: scope.join(' '),
    }
    if (patient != null) {
      payload.patient = patient
    }
    return yield* signJwt(signingKey, payload)
  })

export { verifyJwt, signJwt, mintAccessToken }
export type { VerifiedPayload, MintAccessTokenPayload }
