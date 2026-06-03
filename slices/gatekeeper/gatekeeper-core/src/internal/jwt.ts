import type { HttpServerRequest } from '@effect/platform'
import { HttpApiError } from '@effect/platform'
import { DateTime, type Duration, Effect, pipe } from 'effect'
import type { UnknownException } from 'effect/Cause'
// TEMP: runtime import (was `import type * as jose`) so the debug
// `decodeJwt` log below can read the token's actual `iss`/`aud`/`exp`
// claims without verifying the signature. Revert to a type-only import
// when the temp instrumentation comes out.
import * as jose from 'jose'
import type { Origin } from 'navigation-core'
import { requestOriginFromHttpRequest } from 'navigation-core'
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
// TEMP: debugging gatekeeper unauthorized — carries the jose error message
// so the per-key tap below can surface it; collapsed back to a bare
// `Unauthorized` before exiting `verifyAgainstAnyKey`.
class JoseVerifyFailure {
  readonly _tag = 'JoseVerifyFailure'
  constructor(readonly message: string) {}
}

const verifyAgainstAnyKey = (
  token: string,
  keys: ReadonlyArray<SigningKey.Type>,
  options: { expectedIssuer: string; acceptedAudiences: ReadonlyArray<string> }
): Effect.Effect<jose.JWTVerifyResult<jose.JWTPayload>, HttpApiError.Unauthorized> =>
  pipe(
    keys.map((jwk) =>
      Effect.tryPromise({
        try: () => SigningKey.verifyJwt(jwk, token, options),
        catch: (err) => new JoseVerifyFailure(err instanceof Error ? err.message : String(err)),
      })
    ),
    Effect.firstSuccessOf,
    Effect.catchAll(() =>
      Effect.gen(function* () {
        // TEMP: debugging gatekeeper unauthorized.
        yield* Effect.logInfo(
          `[gatekeeper-auth] verifyAgainstAnyKey: no key verified the token (${keys.length} key(s) tried)`
        )
        return yield* Effect.fail(unauthorized())
      })
    )
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
  // TEMP: debugging gatekeeper unauthorized.
  return Effect.logWarning(
    `[gatekeeper-auth] requireIssuerMatches fail: token.iss=${String(payload.iss)} expected=${expectedIssuer}`
  ).pipe(Effect.zipRight(Effect.fail(unauthorized())))
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
  return Effect.logWarning(
    `[gatekeeper-auth] requireAudienceAccepted fail: token.aud=${JSON.stringify(presented)} accepted=${JSON.stringify(acceptedAudiences)}`
  ).pipe(Effect.zipRight(Effect.fail(unauthorized())))
}

const requireNotExpired = (
  payload: jose.JWTPayload
): Effect.Effect<void, HttpApiError.Unauthorized> =>
  Effect.gen(function* () {
    if (typeof payload.exp !== 'number') return
    const nowDt = yield* DateTime.now
    const nowSeconds = Math.floor(DateTime.toEpochMillis(nowDt) / 1000)
    if (payload.exp <= nowSeconds) {
      yield* Effect.logWarning(
        `[gatekeeper-auth] requireNotExpired fail: exp=${payload.exp} now=${nowSeconds} (token expired ${nowSeconds - payload.exp}s ago)`
      )
      yield* Effect.fail(unauthorized())
    }
  })

const requirePayloadWithRegisteredEnabledSubject = (
  payload: jose.JWTPayload
): Effect.Effect<VerifiedPayload, HttpApiError.Unauthorized, GatekeeperStore> =>
  Effect.gen(function* () {
    if (typeof payload.sub !== 'string') {
      yield* Effect.logWarning(
        `[gatekeeper-auth] requirePayload fail: sub is not a string (got ${typeof payload.sub})`
      )
      return yield* Effect.fail(unauthorized())
    }
    if (typeof payload.iss !== 'string') {
      // TEMP: debugging gatekeeper unauthorized.
      yield* Effect.logWarning(
        `[gatekeeper-auth] requirePayload fail: iss is not a string (got ${typeof payload.iss})`
      )
      return yield* Effect.fail(unauthorized())
    }
    if (typeof payload.aud !== 'string' && !Array.isArray(payload.aud)) {
      // TEMP: debugging gatekeeper unauthorized.
      yield* Effect.logWarning(
        `[gatekeeper-auth] requirePayload fail: aud is neither string nor array (got ${typeof payload.aud})`
      )
      return yield* Effect.fail(unauthorized())
    }
    const store = yield* GatekeeperStore
    const client = store.query(Client.queries.byId$(payload.sub))
    if (client == null || client.disabledAt != null) {
      const disabledAtStr =
        client?.disabledAt == null ? 'n/a' : DateTime.formatIso(client.disabledAt)
      yield* Effect.logWarning(
        `[gatekeeper-auth] requirePayload fail: client lookup — sub=${payload.sub} found=${client != null} disabledAt=${disabledAtStr}`
      )
      return yield* Effect.fail(unauthorized())
    }
    return {
      ...payload,
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
    }
  })

/**
 * Verify a bearer token's signature, issuer, audience, expiry, and
 * registered/enabled subject.
 *
 * **Origin policy:** `expectedIssuer` and `acceptedAudiences` are
 * derived from `requestOriginFromHttpRequest` — the URL the *caller
 * used to reach this server* (trust-gated on the connection's remote
 * address; see `requestOriginFromConnection`). This pairs with the
 * mint-side using the same per-request derivation, so:
 *
 *   - tokens minted on loopback only validate when reused over
 *     loopback (the dev bootstrap-token guarantee — leaked bootstrap
 *     tokens can't be used against the public tunnel URL);
 *   - tokens minted via the tunnel only validate when reused via the
 *     tunnel.
 */
const verifyJwt = (
  token: string
): Effect.Effect<
  VerifiedPayload,
  HttpApiError.Unauthorized | HttpApiError.InternalServerError,
  GatekeeperStore | Origin | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    if (token.trim().length === 0) {
      yield* Effect.logWarning('[gatekeeper-auth] verifyJwt fail: empty token after trim')
      return yield* Effect.fail(unauthorized())
    }
    const store = yield* GatekeeperStore
    const origin = yield* requestOriginFromHttpRequest
    const signingKeys = store.query(SigningKey.queries.all$)
    if (signingKeys.length === 0) {
      yield* Effect.logWarning('[gatekeeper-auth] verifyJwt fail: no signing keys configured (500)')
      // No keys configured is a server-side issue, not a client auth
      // failure — surface as a typed 500.
      return yield* Effect.fail(new HttpApiError.InternalServerError())
    }
    const expectedIssuer = origin
    const acceptedAudiences: ReadonlyArray<string> = [`${origin}/fhir`, origin]
    yield* Effect.logWarning(
      `[gatekeeper-auth] verifyJwt: token-len=${token.length} signingKeys=${signingKeys.length} expectedIssuer=${expectedIssuer} acceptedAudiences=${JSON.stringify(acceptedAudiences)}`
    )
    // TEMP: debugging gatekeeper unauthorized — decode the token without
    // verifying the signature so the actual iss/aud/exp/sub claims show
    // up even when jose.jwtVerify rejects early (e.g. iss mismatch).
    const decoded = yield* Effect.try({
      try: () => jose.decodeJwt(token),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(Effect.either)
    yield* decoded._tag === 'Right'
      ? Effect.logDebug(
          `[gatekeeper-auth] verifyJwt actual claims (unverified): iss=${String(decoded.right.iss)} sub=${String(decoded.right.sub)} aud=${JSON.stringify(decoded.right.aud)} exp=${String(decoded.right.exp)} scope=${String(decoded.right.scope)}`
        )
      : Effect.logWarning(`[gatekeeper-auth] verifyJwt: decodeJwt threw — ${decoded.left}`)
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
