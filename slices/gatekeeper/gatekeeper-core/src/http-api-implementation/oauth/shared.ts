import type { Schema } from 'effect'
import { Duration, Effect } from 'effect'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../../contexts/gatekeeper-store.ts'
import type { OAuthError400Schema, TokenResponseSchema } from '../../http-api-definition/oauth.ts'
import { OAuthError401Schema, OAuthError500Schema } from '../../http-api-definition/oauth.ts'
import { mintAccessToken } from '../../internal/jwt.ts'
import { timingSafeEqual } from '../../internal/timing-safe-equal.ts'
import { Client, type ClientRow, SigningKey } from '../../livestore/index.ts'

const DEVICE_CODE_POLL_INTERVAL: Duration.Duration = Duration.seconds(5)
const ACCESS_TOKEN_TTL: Duration.Duration = Duration.hours(1)

type OAuthError400 = Schema.Schema.Type<typeof OAuthError400Schema>
type OAuthError401 = Schema.Schema.Type<typeof OAuthError401Schema>
type OAuthError500 = Schema.Schema.Type<typeof OAuthError500Schema>
type TokenResponse = Schema.Schema.Type<typeof TokenResponseSchema>

// Builds the OAuth client redirect carrying `code` + `state`. Used by
// both the Authorize handler (for auto-approved requests) and the
// AuthorizationStatus handler. There is no HttpApi-driven URL-builder
// for arbitrary client redirects (the target is a third-party URL, not
// an endpoint we serve), so manual `URL` assembly is unavoidable.
const buildClientRedirectUrl = (redirectUri: string, code: string, clientState: string): string => {
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  url.searchParams.set('state', clientState)
  return url.toString()
}

const sha256Hex = (input: string): Effect.Effect<string, Error> =>
  Effect.tryPromise(async () => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
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

const issueTokenResponse = (input: {
  clientId: string
  grantedScopes: ReadonlyArray<string>
  patient: string | null
}): Effect.Effect<TokenResponse, OAuthError500, GatekeeperStore | Origin> =>
  Effect.gen(function* () {
    const signingKey = yield* pickSigningKeyForMint()
    const origin = yield* Origin
    const signed = yield* mintAccessToken(signingKey, origin, {
      clientId: input.clientId,
      scope: input.grantedScopes,
      ttl: ACCESS_TOKEN_TTL,
      audience: `${origin}/fhir`,
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
