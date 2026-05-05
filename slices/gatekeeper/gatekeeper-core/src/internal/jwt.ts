import { HttpApiError } from '@effect/platform'
import { Clock, Effect } from 'effect'
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

const verifyJwt = (
  token: string
): Effect.Effect<VerifiedPayload, HttpApiError.Unauthorized, GatekeeperStore | Origin> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const origin = yield* Origin
    if (token.trim().length === 0) {
      return yield* Effect.fail(new HttpApiError.Unauthorized())
    }

    const signingKeys = store.query(SigningKeys.queries.all$)
    if (signingKeys.length === 0) {
      return yield* Effect.fail(new HttpApiError.Unauthorized())
    }

    const expectedIssuer = origin
    const acceptedAudiences = [`${origin}/fhir`, origin]
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)

    for (const jwk of signingKeys) {
      const result = yield* Effect.either(Effect.tryPromise(() => jwk.verifyJwt(token)))
      if (result._tag === 'Left') {
        continue
      }

      const payload = result.right.payload

      if (payload.exp != null && payload.exp < nowSeconds) {
        return yield* Effect.fail(new HttpApiError.Unauthorized())
      }

      if (payload.iss !== expectedIssuer) {
        return yield* Effect.fail(new HttpApiError.Unauthorized())
      }

      const audClaim = payload.aud
      let audMatches = false
      if (typeof audClaim === 'string') {
        audMatches = acceptedAudiences.includes(audClaim)
      } else if (Array.isArray(audClaim)) {
        audMatches = audClaim.some((a) => acceptedAudiences.includes(a))
      }
      if (!audMatches) {
        return yield* Effect.fail(new HttpApiError.Unauthorized())
      }

      if (typeof payload.sub !== 'string') {
        return yield* Effect.fail(new HttpApiError.Unauthorized())
      }

      const client = store.query(Clients.queries.byId$(payload.sub))
      if (client == null || client.disabledAt != null) {
        return yield* Effect.fail(new HttpApiError.Unauthorized())
      }

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return payload as VerifiedPayload
    }

    return yield* Effect.fail(new HttpApiError.Unauthorized())
  })

const signJwt = (
  jwk: SigningKey,
  payload: jose.JWTPayload
): Effect.Effect<string, UnknownException> => Effect.tryPromise(() => jwk.signJwt(payload))

type MintAccessTokenPayload = {
  clientId: string
  scope: ReadonlyArray<string>
  ttlSeconds: number
  audience?: string
  patient?: string | null
}

const mintAccessToken = (
  signingKey: SigningKey,
  origin: string,
  { clientId, scope, ttlSeconds, audience, patient }: MintAccessTokenPayload
): Effect.Effect<string, UnknownException> =>
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const payload: jose.JWTPayload = {
      iss: origin,
      sub: clientId,
      aud: audience ?? origin,
      exp: now + ttlSeconds,
      iat: now,
      scope: scope.join(' '),
    }
    if (patient != null) {
      payload.patient = patient
    }
    return yield* signJwt(signingKey, payload)
  })

export { verifyJwt, signJwt, mintAccessToken }
export type { VerifiedPayload, MintAccessTokenPayload }
