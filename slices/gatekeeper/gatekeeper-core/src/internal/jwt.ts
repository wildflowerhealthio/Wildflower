import type { HttpServerRequest } from '@effect/platform'
import { HttpApiError } from '@effect/platform'
import { DateTime, type Duration, Effect, pipe } from 'effect'
import type { UnknownException } from 'effect/Cause'
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
//
// Each attempt's failure carries the jose error `type` (its stable
// `code`, e.g. `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`) and `message`,
// so the catch-all can log the actual reason no key verified rather
// than a bare key count. `firstSuccessOf` surfaces the last attempt's
// failure when every key fails.
class JoseVerifyFailure {
  readonly _tag = 'JoseVerifyFailure'
  constructor(
    readonly type: string,
    readonly message: string
  ) {}
}

// jose errors expose a stable string `code`; prefer it for the failure
// `type`, falling back to the error's constructor name, then a generic
// label for non-`Error` throwables.
const joseErrorType = (err: unknown): string => {
  if (err instanceof Error) {
    if ('code' in err && typeof err.code === 'string') return err.code
    return err.name
  }
  return 'UnknownError'
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
        catch: (err) =>
          new JoseVerifyFailure(joseErrorType(err), err instanceof Error ? err.message : String(err)),
      })
    ),
    Effect.firstSuccessOf,
    Effect.catchAll((failure) =>
      Effect.logWarning(
        `[gatekeeper-auth] verifyAgainstAnyKey: no key verified the token (${keys.length} key(s) tried); last jose error type=${failure.type} message=${failure.message}`
      ).pipe(Effect.zipRight(Effect.fail(unauthorized())))
    )
  )

// Each `require*` below owns one claim's gate and logs its own specific
// rejection reason. They're applied twice per verification (see
// `requireValidClaims`): once on the *unverified* decoded payload as a
// pre-signature fast-fail, and once on the jose-*verified* payload as
// the authoritative gate. The issuer/audience *type* assertions live
// here (not in the subject gate) so each reason is reported at its own
// site.

// Issuer must equal the expected origin. A non-string `iss` can't equal
// a string `expectedIssuer`, so this also covers the wrong-type case.
const requireIssuerMatches = (
  payload: jose.JWTPayload,
  expectedIssuer: string
): Effect.Effect<void, HttpApiError.Unauthorized> => {
  if (payload.iss === expectedIssuer) return Effect.void
  return Effect.logWarning(
    `[gatekeeper-auth] requireIssuerMatches fail: token.iss=${String(payload.iss)} expected=${expectedIssuer}`
  ).pipe(Effect.zipRight(Effect.fail(unauthorized())))
}

const presentedAudiences = (audClaim: jose.JWTPayload['aud']): ReadonlyArray<string> => {
  if (Array.isArray(audClaim)) return audClaim
  if (typeof audClaim === 'string') return [audClaim]
  return []
}

// Audience must intersect the accepted set, and (for the typed return)
// be present as a string or string[]. A missing/ill-typed `aud`
// produces an empty `presented`, so it fails the intersection too.
const requireAudienceAccepted = (
  payload: jose.JWTPayload,
  acceptedAudiences: ReadonlyArray<string>
): Effect.Effect<string | ReadonlyArray<string>, HttpApiError.Unauthorized> => {
  const aud = payload.aud
  const presented = presentedAudiences(aud)
  if (aud !== undefined && presented.some((a) => acceptedAudiences.includes(a))) {
    return Effect.succeed(aud)
  }
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

// Subject must be a string naming a registered, enabled client.
// Returns the narrowed `sub` for the caller to assemble into the
// `VerifiedPayload`; iss/aud are gated by their own `require*` above.
const requireRegisteredEnabledSubject = (
  payload: jose.JWTPayload,
  store: typeof GatekeeperStore.Service
): Effect.Effect<string, HttpApiError.Unauthorized> =>
  Effect.gen(function* () {
    if (typeof payload.sub !== 'string') {
      yield* Effect.logWarning(
        `[gatekeeper-auth] requireSubject fail: sub is not a string (got ${typeof payload.sub})`
      )
      return yield* Effect.fail(unauthorized())
    }
    const client = store.query(Client.queries.byId$(payload.sub))
    if (client == null || client.disabledAt != null) {
      const disabledAtStr =
        client?.disabledAt == null ? 'n/a' : DateTime.formatIso(client.disabledAt)
      yield* Effect.logWarning(
        `[gatekeeper-auth] requireSubject fail: client lookup — sub=${payload.sub} found=${client != null} disabledAt=${disabledAtStr}`
      )
      return yield* Effect.fail(unauthorized())
    }
    return payload.sub
  })

// Full claim gate over a payload (issuer + audience + expiry +
// registered/enabled subject), assembling the typed `VerifiedPayload`.
// Run twice per verification: as an *advisory* pre-signature fast-fail
// over the unverified decoded payload (so each rejection reason gets a
// specific log before the expensive RSA verify), and as the
// *authoritative* gate over the jose-verified payload. Reusing one
// function guarantees the pre-checks cover exactly the post-check
// conditions — the parity the security posture relies on. `iss` in the
// result is `expectedIssuer` (which `requireIssuerMatches` proved the
// claim equals); the pre-pass result is discarded by the caller.
const requireValidClaims = (
  payload: jose.JWTPayload,
  store: typeof GatekeeperStore.Service,
  options: { expectedIssuer: string; acceptedAudiences: ReadonlyArray<string> }
): Effect.Effect<VerifiedPayload, HttpApiError.Unauthorized> =>
  Effect.gen(function* () {
    yield* requireIssuerMatches(payload, options.expectedIssuer)
    const aud = yield* requireAudienceAccepted(payload, options.acceptedAudiences)
    yield* requireNotExpired(payload)
    const sub = yield* requireRegisteredEnabledSubject(payload, store)
    return { ...payload, iss: options.expectedIssuer, sub, aud }
  })

// Decode the unverified token payload for the pre-signature fast-fail.
// Advisory only — a malformed token that `decodeJwt` can't parse is
// rejected up front, but the accept decision still rests on jose
// signature verification plus the authoritative `requireValidClaims`.
const decodeUnverifiedPayload = (
  token: string
): Effect.Effect<jose.JWTPayload, HttpApiError.Unauthorized> =>
  Effect.try({
    try: () => jose.decodeJwt(token),
    catch: () => unauthorized(),
  }).pipe(
    Effect.tapError(() =>
      Effect.logWarning('[gatekeeper-auth] verifyJwt fail: malformed token (decodeJwt threw)')
    )
  )

// Narrow the candidate signing keys to those whose `kid` matches the
// token's protected header (mint sets `kid` via `setProtectedHeader`).
// On no match — or a token with no `kid` — fall back to every key and
// log it, so rotation/legacy tokens still verify by brute force. A
// header that won't decode is treated as a malformed token.
const selectSigningKeys = (
  token: string,
  keys: ReadonlyArray<SigningKey.Type>
): Effect.Effect<ReadonlyArray<SigningKey.Type>, HttpApiError.Unauthorized> =>
  Effect.gen(function* () {
    const header = yield* Effect.try({
      try: () => jose.decodeProtectedHeader(token),
      catch: () => unauthorized(),
    }).pipe(
      Effect.tapError(() =>
        Effect.logWarning('[gatekeeper-auth] verifyJwt fail: malformed protected header')
      )
    )
    const kid = header.kid
    if (typeof kid === 'string') {
      const matched = keys.filter((k) => k.kid === kid)
      if (matched.length > 0) return matched
      yield* Effect.logInfo(
        `[gatekeeper-auth] key selection: token kid=${kid} matched no signing key; falling back to all ${keys.length} key(s)`
      )
    } else {
      yield* Effect.logInfo(
        `[gatekeeper-auth] key selection: token has no kid header; trying all ${keys.length} key(s)`
      )
    }
    return keys
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
    const origin = yield* requestOriginFromHttpRequest.pipe(
      Effect.catchTag('UntrustedRemotePeer', (e) =>
        Effect.logWarning(
          `[gatekeeper-auth] verifyJwt fail: untrusted remote peer (remoteAddress=${String(e.remoteAddress)})`
        ).pipe(Effect.zipRight(Effect.fail(unauthorized())))
      )
    )
    const signingKeys = store.query(SigningKey.queries.all$)
    if (signingKeys.length === 0) {
      yield* Effect.logWarning('[gatekeeper-auth] verifyJwt fail: no signing keys configured (500)')
      // No keys configured is a server-side issue, not a client auth
      // failure — surface as a typed 500.
      return yield* Effect.fail(new HttpApiError.InternalServerError())
    }
    const expectedIssuer = origin
    const acceptedAudiences: ReadonlyArray<string> = [`${origin}/fhir-r4`, origin]
    const options = { expectedIssuer, acceptedAudiences }

    // Pre-signature fast-fail on the unverified claims: each rejected
    // reason (issuer/audience/expiry/subject) gets a specific log before
    // the expensive RSA verify. Advisory only — never an accept; the
    // result is discarded.
    const unverified = yield* decodeUnverifiedPayload(token)
    yield* requireValidClaims(unverified, store, options)

    // Authoritative signature gate: narrow to kid-matched keys, then
    // require a jose verification to succeed.
    const candidateKeys = yield* selectSigningKeys(token, signingKeys)
    const verified = yield* verifyAgainstAnyKey(token, candidateKeys, options)

    // Authoritative claim gate over the verified payload (belt and
    // braces: a `SigningKey` impl that bypasses jose still gets gated).
    return yield* requireValidClaims(verified.payload, store, options)
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
