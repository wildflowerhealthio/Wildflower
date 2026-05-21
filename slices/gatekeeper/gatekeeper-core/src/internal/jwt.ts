import { HttpApiError } from '@effect/platform'
import { DateTime, type Duration, Effect, pipe } from 'effect'
import type { UnknownException } from 'effect/Cause'
import type * as jose from 'jose'
import { Origin } from 'navigation-core'
import { Client, GatekeeperStore, SigningKey } from '../livestore/index.ts'
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
  keys: ReadonlyArray<SigningKey.Type>,
  options: { expectedIssuer: string; acceptedAudiences: ReadonlyArray<string> }
): Effect.Effect<jose.JWTVerifyResult<jose.JWTPayload>, HttpApiError.Unauthorized> =>
  pipe(
    keys.map((jwk) =>
      Effect.tryPromise({
        try: () => SigningKey.verifyJwt(jwk, token, options),
        catch: () => unauthorized(),
      })
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
): Effect.Effect<void, HttpApiError.Unauthorized> => {
  if (payload.iss === expectedIssuer) return Effect.void
  return Effect.fail(unauthorized())
}

const presentedAudiences = (audClaim: jose.JWTPayload['aud']): ReadonlyArray<string> => {
  if (Array.isArray(audClaim)) return audClaim
  if (typeof audClaim === 'string') return [audClaim]
  return []
}

const requireAudienceAccepted = (
  payload: jose.JWTPayload,
  acceptedAudiences: ReadonlyArray<string>
): Effect.Effect<void, HttpApiError.Unauthorized> => {
  const presented = presentedAudiences(payload.aud)
  if (presented.some((a) => acceptedAudiences.includes(a))) return Effect.void
  return Effect.fail(unauthorized())
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

const requirePayloadWithRegisteredEnabledSubject = (
  payload: jose.JWTPayload
): Effect.Effect<VerifiedPayload, HttpApiError.Unauthorized, GatekeeperStore> =>
  Effect.gen(function* () {
    if (typeof payload.sub !== 'string') {
      return yield* Effect.fail(unauthorized())
    }
    if (typeof payload.iss !== 'string') {
      return yield* Effect.fail(unauthorized())
    }
    if (typeof payload.aud !== 'string' && !Array.isArray(payload.aud)) {
      return yield* Effect.fail(unauthorized())
    }
    const store = yield* GatekeeperStore
    const client = store.query(Client.queries.byId$(payload.sub))
    if (client == null || client.disabledAt != null) {
      return yield* Effect.fail(unauthorized())
    }
    return {
      ...payload,
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
    }
  })

const verifyJwt = (
  token: string
): Effect.Effect<
  VerifiedPayload,
  HttpApiError.Unauthorized | HttpApiError.InternalServerError,
  GatekeeperStore | Origin
> =>
  Effect.gen(function* () {
    if (token.trim().length === 0) {
      return yield* Effect.fail(unauthorized())
    }
    const store = yield* GatekeeperStore
    const origin = yield* Origin.get
    const signingKeys = store.query(SigningKey.queries.all$)
    if (signingKeys.length === 0) {
      // No keys configured is a server-side issue, not a client auth
      // failure — surface as a typed 500.
      return yield* Effect.fail(new HttpApiError.InternalServerError())
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
    return yield* requirePayloadWithRegisteredEnabledSubject(verified.payload)
  })

const signJwt = (
  jwk: SigningKey.Type,
  payload: jose.JWTPayload
): Effect.Effect<string, UnknownException> =>
  Effect.tryPromise(() => SigningKey.signJwt(jwk, payload))

type MintAccessTokenPayload = {
  clientId: string
  scope: ReadonlyArray<string>
  ttl: Duration.Duration
  audience?: string
  patient?: string | null
}

const mintAccessToken = (
  signingKey: SigningKey.Type,
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
