/* oxlint-disable */
import { HttpApiError } from '@effect/platform'
import { Effect } from 'effect'
import type { UnknownException } from 'effect/Cause'
import type * as jose from 'jose'
import { AuthStore } from '../contexts/AuthStore.ts'
import { ApprovedApps, JsonWebKeys, type RsaJwk } from '../livestore/index.ts'

const verifyJwt = (token: string): Effect.Effect<void, HttpApiError.Unauthorized, AuthStore> =>
  Effect.gen(function* () {
    const store = yield* AuthStore
    if (token.trim().length === 0) {
      return yield* Effect.fail(new HttpApiError.Unauthorized())
    }

    const jsonWebKeys = store.query(JsonWebKeys.queries.allJwks$)
    if (jsonWebKeys.length === 0) {
      return yield* Effect.fail(new HttpApiError.Unauthorized())
    }

    for (const jwk of jsonWebKeys) {
      const result = yield* Effect.either(Effect.tryPromise(() => jwk.verifyJwt(token)))
      if (result._tag === 'Left') {
        continue
      }

      if (
        result.right.payload.exp != null &&
        result.right.payload.exp < Math.floor(Date.now() / 1000)
      ) {
        return yield* Effect.fail(new HttpApiError.Unauthorized())
      }

      const clientId =
        typeof result.right.payload.sub === 'string' ? result.right.payload.sub : null
      if (clientId != null) {
        const approved = store.query(ApprovedApps.queries.byClientId$(clientId))
        if (approved.length === 0) {
          return yield* Effect.fail(new HttpApiError.Unauthorized())
        }
      }

      return
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
