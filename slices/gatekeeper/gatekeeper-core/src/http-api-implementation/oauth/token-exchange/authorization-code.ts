import type { Schema } from 'effect'
import { DateTime, Effect, pipe } from 'effect'
import type { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../../../contexts/gatekeeper-store.ts'
import type { AuthorizationCodePayload } from '../../../http-api-definition/oauth.ts'
import { OAuthError400Schema, OAuthError500Schema } from '../../../http-api-definition/oauth.ts'
import { computeCodeChallenge } from '../../../internal/pkce.ts'
import { timingSafeEqual } from '../../../internal/timing-safe-equal.ts'
import { AuthorizationCode, type AuthorizationCodeRow } from '../../../livestore/index.ts'
import {
  issueTokenResponse,
  type OAuthError400,
  type OAuthError401,
  type OAuthError500,
  requireValidClientForToken,
  type TokenResponse,
} from '../shared.ts'

type AuthorizationCodeExchange = Schema.Schema.Type<typeof AuthorizationCodePayload>

const getIssuedAuthorizationCode = (
  code: string
): Effect.Effect<AuthorizationCodeRow, OAuthError400, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const issued = store.query(AuthorizationCode.queries.byCode$(code))
    if (issued == null) {
      return yield* Effect.fail(
        OAuthError400Schema.make({
          error: 'invalid_request',
          error_description: 'Invalid code parameter',
        })
      )
    }
    return issued
  })

const requireCodeMatchesClient = (
  issuedCode: AuthorizationCodeRow,
  clientId: string
): Effect.Effect<void, OAuthError400> => {
  if (issuedCode.clientId === clientId) return Effect.void
  return Effect.fail(
    OAuthError400Schema.make({
      error: 'invalid_request',
      error_description: 'Invalid client_id parameter',
    })
  )
}

const requireCodeMatchesRedirectUri = (
  issuedCode: AuthorizationCodeRow,
  redirectUri: string
): Effect.Effect<void, OAuthError400> => {
  if (issuedCode.redirectUri === redirectUri) return Effect.void
  return Effect.fail(
    OAuthError400Schema.make({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri parameter',
    })
  )
}

const requireCodeNotExpired = (
  issuedCode: AuthorizationCodeRow
): Effect.Effect<void, OAuthError400> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    if (DateTime.lessThan(issuedCode.expiresAt, now)) {
      yield* Effect.fail(
        OAuthError400Schema.make({
          error: 'invalid_request',
          error_description: 'Code has expired',
        })
      )
    }
  })

const requireValidCodeVerifier = (
  issuedCode: AuthorizationCodeRow,
  codeVerifier: string
): Effect.Effect<void, OAuthError400 | OAuthError500> =>
  Effect.gen(function* () {
    const computed = yield* computeCodeChallenge(codeVerifier).pipe(
      Effect.mapError(() =>
        OAuthError500Schema.make({
          error: 'server_error',
          error_description: 'Failed to compute code challenge',
        })
      )
    )
    if (!timingSafeEqual(issuedCode.codeChallenge, computed)) {
      yield* Effect.fail(
        OAuthError400Schema.make({
          error: 'invalid_request',
          error_description: 'Invalid code_verifier parameter',
        })
      )
    }
  })

const consumeAuthorizationCode = (code: string): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    store.commit(AuthorizationCode.events.authorizationCodeConsumed({ code }))
  })

const handleAuthorizationCodeTokenExchange = (
  payload: AuthorizationCodeExchange
): Effect.Effect<
  TokenResponse,
  OAuthError400 | OAuthError401 | OAuthError500,
  GatekeeperStore | Origin
> =>
  Effect.gen(function* () {
    yield* requireValidClientForToken(payload.client_id, payload.client_secret)
    const issuedCode = yield* getIssuedAuthorizationCode(payload.code)
    return yield* pipe(
      Effect.gen(function* () {
        yield* requireCodeMatchesClient(issuedCode, payload.client_id)
        yield* requireCodeMatchesRedirectUri(issuedCode, payload.redirect_uri)
        yield* requireCodeNotExpired(issuedCode)
        yield* requireValidCodeVerifier(issuedCode, payload.code_verifier)
        return yield* issueTokenResponse({
          clientId: issuedCode.clientId,
          grantedScopes: issuedCode.grantedScopes,
          patient: issuedCode.patient,
        })
      }),
      // Whether validation succeeds or fails, burn the code: any attempt
      // against an existing code consumes it (defense against replay).
      Effect.ensuring(consumeAuthorizationCode(issuedCode.code))
    )
  })

export { handleAuthorizationCodeTokenExchange }
