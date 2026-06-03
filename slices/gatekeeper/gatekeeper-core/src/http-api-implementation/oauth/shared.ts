import type { HttpServerRequest } from '@effect/platform'
import { Duration, Effect, type Schema } from 'effect'
import { UnknownException } from 'effect/Cause'
import type { Origin } from 'navigation-core'
import { requestOriginFromHttpRequest } from 'navigation-core'
import {
  type OAuthError400Schema,
  OAuthError401Schema,
  OAuthError500Schema,
  type TokenResponseSchema,
} from '../../http-api-definition/oauth.ts'
import { mintAccessToken } from '../../internal/jwt.ts'
import { timingSafeEqual } from '../../internal/timing-safe-equal.ts'
import { Client, type ClientRow, GatekeeperStore, SigningKey } from '../../livestore/index.ts'
const DEVICE_CODE_POLL_INTERVAL: Duration.Duration = Duration.seconds(5)
const ACCESS_TOKEN_TTL: Duration.Duration = Duration.hours(1)

type OAuthError400 = Schema.Schema.Type<typeof OAuthError400Schema>
type OAuthError401 = Schema.Schema.Type<typeof OAuthError401Schema>
type OAuthError500 = Schema.Schema.Type<typeof OAuthError500Schema>
type TokenResponse = Schema.Schema.Type<typeof TokenResponseSchema>

// Manual `URL` assembly: the target is a third-party redirect, not a route we serve.
const buildClientRedirectUrl = (redirectUri: string, code: string, clientState: string): string => {
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  url.searchParams.set('state', clientState)
  return url.toString()
}

const sha256Hex = (input: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
    },
    catch(error) {
      return new UnknownException(error, 'Error while computing SHA-256 hash')
    },
  })

const requireValidClientForToken = (
  clientId: string,
  clientSecret: string | undefined
): Effect.Effect<ClientRow, OAuthError401 | OAuthError500, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const client = store.query(Client.queries.byId$(clientId))
    if (client == null) {
      return yield* Effect.fail(
        OAuthError401Schema.make({
          error: 'invalid_client',
          error_description: 'Unknown client_id',
        })
      )
    }
    if (client.disabledAt != null) {
      return yield* Effect.fail(
        OAuthError401Schema.make({
          error: 'invalid_client',
          error_description: 'Client is disabled',
        })
      )
    }
    if (client.kind === 'public') return client
    if (client.secretHash == null) {
      return yield* Effect.fail(
        OAuthError401Schema.make({
          error: 'invalid_client',
          error_description: 'Client secret not configured',
        })
      )
    }
    if (clientSecret == null) {
      return yield* Effect.fail(
        OAuthError401Schema.make({
          error: 'invalid_client',
          error_description: 'Client secret required',
        })
      )
    }
    const presentedHash = yield* sha256Hex(clientSecret).pipe(
      Effect.mapError(() =>
        OAuthError500Schema.make({
          error: 'server_error',
          error_description: 'Failed to hash client_secret',
        })
      )
    )
    if (!timingSafeEqual(presentedHash, client.secretHash)) {
      return yield* Effect.fail(
        OAuthError401Schema.make({
          error: 'invalid_client',
          error_description: 'Invalid client_secret',
        })
      )
    }
    return client
  })

const pickSigningKeyForMint = (): Effect.Effect<SigningKey.Type, OAuthError500, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const active = store.query(SigningKey.queries.active$)
    const all = store.query(SigningKey.queries.all$)
    const chosen = active ?? all[0]
    if (chosen === undefined) {
      return yield* Effect.fail(
        OAuthError500Schema.make({
          error: 'server_error',
          error_description: 'No JSON Web Keys available to sign token',
        })
      )
    }
    return chosen
  })

/**
 * Mint an OAuth access token response.
 *
 * **Origin policy:** `iss` and `aud` are derived from
 * `requestOriginFromHttpRequest` — the URL the *caller used to reach
 * this server* (trust-gated; see `requestOriginFromConnection`). Pairs
 * with the verifier (`verifyJwt`) using the same per-request
 * derivation, so a token minted from a loopback POST only validates on
 * loopback, and a token minted from a tunnel POST only validates over
 * the tunnel.
 */
const issueTokenResponse = (input: {
  clientId: string
  grantedScopes: ReadonlyArray<string>
  patient: string | null
}): Effect.Effect<
  TokenResponse,
  OAuthError500,
  GatekeeperStore | Origin | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const signingKey = yield* pickSigningKeyForMint()
    const origin = yield* requestOriginFromHttpRequest
    const signed = yield* mintAccessToken(signingKey, origin, {
      clientId: input.clientId,
      scope: input.grantedScopes,
      ttl: ACCESS_TOKEN_TTL,
      audience: `${origin}/fhir-r4`,
      patient: input.patient,
    }).pipe(
      Effect.mapError(() =>
        OAuthError500Schema.make({
          error: 'server_error',
          error_description: 'Failed to sign JWT',
        })
      )
    )
    return {
      access_token: signed,
      token_type: 'Bearer',
      expires_in: Math.floor(Duration.toSeconds(ACCESS_TOKEN_TTL)),
      scope: input.grantedScopes.join(' '),
      patient: input.patient ?? undefined,
    }
  })

export {
  ACCESS_TOKEN_TTL,
  DEVICE_CODE_POLL_INTERVAL,
  buildClientRedirectUrl,
  issueTokenResponse,
  requireValidClientForToken,
  sha256Hex,
}
export type { OAuthError400, OAuthError401, OAuthError500, TokenResponse }
