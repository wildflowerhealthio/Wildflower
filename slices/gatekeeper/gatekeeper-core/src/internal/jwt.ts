import { HttpApiError } from '@effect/platform'
import { Effect } from 'effect'
import type { UnknownException } from 'effect/Cause'
import type * as jose from 'jose'
import { Origin } from 'kitchen-sink'
import { AuthStore } from '../contexts/AuthStore.ts'
import { Clients, JsonWebKeys, type RsaJwk } from '../livestore/index.ts'

const verifyJwt = (
  token: string
): Effect.Effect<void, HttpApiError.Unauthorized, AuthStore | Origin> =>
  Effect.gen(function* () {
    const store = yield* AuthStore
    const origin = yield* Origin
    if (token.trim().length === 0) {
      return yield* Effect.fail(new HttpApiError.Unauthorized())
    }

    const jsonWebKeys = store.query(JsonWebKeys.queries.allJwks$)
    if (jsonWebKeys.length === 0) {
      return yield* Effect.fail(new HttpApiError.Unauthorized())
    }

    const expectedIssuer = `${origin}/fhir`
    const acceptedAudiences = [`${origin}/fhir`, origin]

    for (const jwk of jsonWebKeys) {
      const result = yield* Effect.either(Effect.tryPromise(() => jwk.verifyJwt(token)))
      if (result._tag === 'Left') {
        continue
      }

      const payload = result.right.payload

      if (payload.exp != null && payload.exp < Math.floor(Date.now() / 1000)) {
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
      const clientId = payload.sub
      const approved = store.query(Clients.queries.byClientId$(clientId))
      if (approved.length === 0) {
        return yield* Effect.fail(new HttpApiError.Unauthorized())
      }

      return undefined
    }

    return yield* Effect.fail(new HttpApiError.Unauthorized())
  })

const signJwt = (jwk: RsaJwk, payload: jose.JWTPayload): Effect.Effect<string, UnknownException> =>
  Effect.tryPromise(() => jwk.signJwt(payload))

const signSessionJwt = (
  jwk: RsaJwk,
  payload: Omit<jose.JWTPayload, 'iat' | 'exp'>,
  maxAgeSeconds: number
): Effect.Effect<string, UnknownException> =>
  Effect.gen(function* () {
    const now = Math.floor(Date.now() / 1000)
    return yield* signJwt(jwk, {
      ...payload,
      iat: now,
      exp: now + maxAgeSeconds,
    })
  })

export { verifyJwt, signJwt, signSessionJwt }
