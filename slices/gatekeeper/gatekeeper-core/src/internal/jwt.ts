import { HttpApiError } from '@effect/platform'
import { Effect } from 'effect'
import type { UnknownException } from 'effect/Cause'
import type * as jose from 'jose'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../contexts/GatekeeperStore.ts'
import { Grants, Sessions, SigningKeys, type SigningKey } from '../livestore/index.ts'

const verifyJwt = (
  token: string
): Effect.Effect<void, HttpApiError.Unauthorized, GatekeeperStore | Origin> =>
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

    const expectedIssuer = `${origin}/fhir`
    const acceptedAudiences = [`${origin}/fhir`, origin]

    for (const jwk of signingKeys) {
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
      const sub = payload.sub
      const tokenType = payload['type']

      if (tokenType === 'access_token') {
        const grants = store.query(Grants.queries.byClientId$(sub))
        if (grants.length === 0) {
          return yield* Effect.fail(new HttpApiError.Unauthorized())
        }
        return undefined
      }

      if (tokenType === 'session') {
        const session = store.query(Sessions.queries.byId$(sub))
        if (session == null) {
          return yield* Effect.fail(new HttpApiError.Unauthorized())
        }
        return undefined
      }

      return yield* Effect.fail(new HttpApiError.Unauthorized())
    }

    return yield* Effect.fail(new HttpApiError.Unauthorized())
  })

const signJwt = (
  jwk: SigningKey,
  payload: jose.JWTPayload
): Effect.Effect<string, UnknownException> => Effect.tryPromise(() => jwk.signJwt(payload))

const signSessionJwt = (
  jwk: SigningKey,
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
