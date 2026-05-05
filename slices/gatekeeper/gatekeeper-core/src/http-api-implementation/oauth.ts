import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Array, DateTime, Effect } from 'effect'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { httpApiGroup } from '../http-api-definition/oauth.ts'
import { oauthErrorHtml } from '../internal/error-pages.ts'
import { mintAccessToken } from '../internal/jwt.ts'
import { computeCodeChallenge } from '../internal/pkce.ts'
import { timingSafeEqual } from '../internal/timing-safe-equal.ts'
import { generateUserCode } from '../internal/user-code.ts'
import {
  AuthorizationCodes,
  AuthorizationRequests,
  Clients,
  type ClientRow,
  Grants,
  SigningKeys,
} from '../livestore/index.ts'

const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5

type OAuthError400 = {
  error:
    | 'invalid_request'
    | 'invalid_grant'
    | 'invalid_scope'
    | 'authorization_pending'
    | 'access_denied'
    | 'expired_token'
    | 'slow_down'
  error_description?: string
}
type OAuthError401 = {
  error: 'invalid_client'
  error_description?: string
}
type OAuthError500 = {
  error: 'server_error'
  error_description?: string
}

const buildClientRedirect = (redirectUri: string, code: string, clientState: string): string => {
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  url.searchParams.set('state', clientState)
  return url.toString()
}

const layer = HttpApiBuilder.group(GatekeeperApi, 'oauth', (handlers) =>
  handlers
    .handleRaw('Authorize', ({ urlParams }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore

        const signingKeys = store.query(SigningKeys.queries.all$)
        if (!Array.isNonEmptyReadonlyArray(signingKeys)) {
          return HttpServerResponse.empty({ status: 503 })
        }

        const { code_challenge_method, client_id, scope, code_challenge, redirect_uri } = urlParams
        const stateParam = urlParams.state

        if (code_challenge_method !== 'S256') {
          return HttpServerResponse.text(
            oauthErrorHtml('unsupported_code_challenge', code_challenge_method),
            { status: 400, contentType: 'text/html; charset=utf-8' }
          )
        }

        let parsedRedirect: URL
        try {
          parsedRedirect = new URL(redirect_uri)
        } catch {
          return HttpServerResponse.text(oauthErrorHtml('invalid_redirect_uri'), {
            status: 400,
            contentType: 'text/html; charset=utf-8',
          })
        }

        if (parsedRedirect.protocol !== 'http:' && parsedRedirect.protocol !== 'https:') {
          return HttpServerResponse.text(oauthErrorHtml('invalid_scheme'), {
            status: 400,
            contentType: 'text/html; charset=utf-8',
          })
        }

        const client = store.query(Clients.queries.byId$(client_id))
        if (client == null) {
          return HttpServerResponse.text(oauthErrorHtml('unknown_client'), {
            status: 400,
            contentType: 'text/html; charset=utf-8',
          })
        }
        if (client.disabledAt != null) {
          return HttpServerResponse.text(oauthErrorHtml('disabled_client'), {
            status: 400,
            contentType: 'text/html; charset=utf-8',
          })
        }
        if (!client.redirectUris.includes(redirect_uri)) {
          return HttpServerResponse.text(oauthErrorHtml('redirect_uri_not_allowed'), {
            status: 400,
            contentType: 'text/html; charset=utf-8',
          })
        }
        const requestedScopes = scope.split(' ').filter(Boolean)
        const allowedScopeSet = new Set(client.allowedScopes)
        const allRequestedScopesAllowed = requestedScopes.every((s) => allowedScopeSet.has(s))
        if (!allRequestedScopesAllowed) {
          return HttpServerResponse.text(oauthErrorHtml('scope_not_allowed'), {
            status: 400,
            contentType: 'text/html; charset=utf-8',
          })
        }

        const requestId = crypto.randomUUID()

        const approvedGrant = store.query(
          Grants.queries.byClientIdAndRedirectUri$(client_id, redirect_uri)
        )

        const previouslyApproved = new Set<string>(approvedGrant?.scopes ?? [])
        const preApproved = requestedScopes.filter((requested) => previouslyApproved.has(requested))
        let preApprovedToPersist: ReadonlyArray<string> | null = null
        if (preApproved.length > 0) {
          preApprovedToPersist = preApproved
        }

        const requestedAt = yield* DateTime.now
        const requestExpiresAt = DateTime.addDuration(requestedAt, '5 minutes')

        store.commit(
          AuthorizationRequests.events.authorizationRequestStarted({
            id: requestId,
            clientId: client_id,
            requestedScopes,
            codeChallenge: code_challenge,
            codeChallengeMethod: code_challenge_method,
            redirectUri: redirect_uri,
            clientState: stateParam,
            preApprovedScopes: preApprovedToPersist,
            requestedAt,
            expiresAt: requestExpiresAt,
          })
        )

        if (approvedGrant != null) {
          const allScopesApproved = requestedScopes.every((requested) =>
            previouslyApproved.has(requested)
          )
          if (allScopesApproved) {
            const code = crypto.randomUUID()
            const issuedAt = yield* DateTime.now
            const codeExpiresAt = DateTime.addDuration(issuedAt, '60 seconds')
            store.commit(
              AuthorizationRequests.events.authorizationRequestApproved({
                id: requestId,
                grantedScopes: requestedScopes,
                patient: approvedGrant.patient ?? null,
              }),
              AuthorizationCodes.events.authorizationCodeIssued({
                code,
                requestId,
                clientId: client_id,
                redirectUri: redirect_uri,
                codeChallenge: code_challenge,
                grantedScopes: requestedScopes,
                patient: approvedGrant.patient ?? null,
                issuedAt,
                expiresAt: codeExpiresAt,
              })
            )
            return HttpServerResponse.redirect(
              buildClientRedirect(redirect_uri, code, stateParam),
              { status: 302 }
            )
          }
        }

        const origin = yield* Origin
        return HttpServerResponse.redirect(`${origin}/oauth/authorize/${requestId}/ui`, {
          status: 302,
        })
      })
    )
    .handle('AuthorizationStatus', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore

        const request = store.query(AuthorizationRequests.queries.byId$(id))
        if (request == null) {
          return yield* Effect.fail({
            error: 'AuthorizationRequestNotFound' as const,
            id,
          })
        }

        if (request.status === 'approved') {
          if (request.redirectUri == null || request.clientState == null) {
            return yield* Effect.fail({
              error: 'server_error' as const,
              error_description: 'Authorization request is not a code-flow request',
            } satisfies OAuthError500)
          }
          const issuedCode = store.query(AuthorizationCodes.queries.byRequestId$(id))
          if (issuedCode == null) {
            return yield* Effect.fail({
              error: 'server_error' as const,
              error_description: 'Authorization code missing',
            } satisfies OAuthError500)
          }
          return {
            status: 'approved' as const,
            redirect: buildClientRedirect(
              request.redirectUri,
              issuedCode.code,
              request.clientState
            ),
          }
        }

        if (request.status === 'denied') {
          return { status: 'declined' as const }
        }

        if (request.status === 'expired') {
          return { status: 'error' as const, message: 'Authorization request expired' }
        }

        return { status: 'pending' as const }
      })
    )
    .handle('TokenExchange', ({ payload }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        if (payload.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          return yield* handleDeviceCodeTokenExchange(store, payload)
        }
        return yield* handleAuthorizationCodeTokenExchange(store, payload)
      })
    )
    .handle('DeviceAuthorization', ({ payload }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const requestedScopes = (payload.scope ?? '').split(' ').filter(Boolean)

        const client = store.query(Clients.queries.byId$(payload.client_id))
        if (client == null || client.disabledAt != null) {
          return yield* Effect.fail({
            error: 'invalid_client' as const,
            error_description: 'Unknown or disabled client_id',
          } satisfies OAuthError401)
        }
        const allowedScopeSet = new Set(client.allowedScopes)
        if (!requestedScopes.every((s) => allowedScopeSet.has(s))) {
          return yield* Effect.fail({
            error: 'invalid_scope' as const,
            error_description: 'Scope not allowed for client',
          } satisfies OAuthError400)
        }

        const requestedAt = yield* DateTime.now
        const expiresAt = DateTime.addDuration(requestedAt, '5 minutes')
        const id = crypto.randomUUID()
        const userCode = generateUniqueUserCode(store)

        store.commit(
          AuthorizationRequests.events.deviceAuthorizationRequestStarted({
            id,
            clientId: payload.client_id,
            requestedScopes,
            userCode,
            requestedAt,
            expiresAt,
          })
        )

        const origin = yield* Origin
        return {
          device_code: id,
          user_code: userCode,
          verification_uri: `${origin}/access/devices`,
          verification_uri_complete: `${origin}/access/devices?user_code=${userCode}`,
          expires_in: 300,
          interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
        }
      })
    )
)

type AuthorizationCodeExchange = {
  readonly grant_type: 'authorization_code'
  readonly client_id: string
  readonly client_secret?: string
  readonly code: string
  readonly code_verifier: string
  readonly redirect_uri: string
}

type DeviceCodeExchange = {
  readonly grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  readonly client_id: string
  readonly client_secret?: string
  readonly device_code: string
}

type TokenExchangeError = OAuthError400 | OAuthError401 | OAuthError500
type TokenResponse = {
  readonly access_token: string
  readonly token_type: string
  readonly expires_in: number
  readonly scope: string
  readonly patient: string | null | undefined
}

const handleAuthorizationCodeTokenExchange = (
  store: typeof GatekeeperStore.Service,
  payload: AuthorizationCodeExchange
): Effect.Effect<TokenResponse, TokenExchangeError, Origin> =>
  Effect.gen(function* () {
    const { client_id, client_secret, code, code_verifier, redirect_uri } = payload

    yield* validateClientForToken(store, client_id, client_secret)

    const issuedCode = store.query(AuthorizationCodes.queries.byCode$(code))
    if (issuedCode == null) {
      return yield* Effect.fail({
        error: 'invalid_request' as const,
        error_description: 'Invalid code parameter',
      } satisfies OAuthError400)
    }

    if (issuedCode.clientId !== client_id) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
      return yield* Effect.fail({
        error: 'invalid_request' as const,
        error_description: 'Invalid client_id parameter',
      } satisfies OAuthError400)
    }

    if (issuedCode.redirectUri !== redirect_uri) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
      return yield* Effect.fail({
        error: 'invalid_request' as const,
        error_description: 'Invalid redirect_uri parameter',
      } satisfies OAuthError400)
    }

    const tokenNow = yield* DateTime.now
    if (DateTime.lessThan(issuedCode.expiresAt, tokenNow)) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
      return yield* Effect.fail({
        error: 'invalid_request' as const,
        error_description: 'Code has expired',
      } satisfies OAuthError400)
    }

    const computedChallenge = yield* computeCodeChallenge(code_verifier).pipe(
      Effect.mapError(
        () =>
          ({
            error: 'server_error' as const,
            error_description: 'Failed to compute code challenge',
          }) satisfies OAuthError500
      )
    )

    if (!timingSafeEqual(issuedCode.codeChallenge, computedChallenge)) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
      return yield* Effect.fail({
        error: 'invalid_request' as const,
        error_description: 'Invalid code_verifier parameter',
      } satisfies OAuthError400)
    }

    store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
    return yield* issueTokenResponse(store, {
      clientId: issuedCode.clientId,
      grantedScopes: issuedCode.grantedScopes,
      patient: issuedCode.patient,
    })
  })

const handleDeviceCodeTokenExchange = (
  store: typeof GatekeeperStore.Service,
  payload: DeviceCodeExchange
): Effect.Effect<TokenResponse, TokenExchangeError, Origin> =>
  Effect.gen(function* () {
    const { client_id, client_secret, device_code } = payload

    yield* validateClientForToken(store, client_id, client_secret)

    const pending = store.query(AuthorizationRequests.queries.byId$(device_code))
    if (pending == null || pending.flow !== 'device_code' || pending.clientId !== client_id) {
      return yield* Effect.fail({
        error: 'invalid_grant' as const,
        error_description: 'Unknown device_code',
      } satisfies OAuthError400)
    }

    const now = yield* DateTime.now
    if (DateTime.lessThan(pending.expiresAt, now)) {
      return yield* Effect.fail({ error: 'expired_token' as const } satisfies OAuthError400)
    }

    if (pending.lastPolledAt != null) {
      const intervalMs = DEVICE_CODE_POLL_INTERVAL_SECONDS * 1000
      const sinceLastPoll = DateTime.distance(pending.lastPolledAt, now)
      if (sinceLastPoll < intervalMs) {
        return yield* Effect.fail({ error: 'slow_down' as const } satisfies OAuthError400)
      }
    }
    store.commit(
      AuthorizationRequests.events.deviceAuthorizationPolled({ id: pending.id, polledAt: now })
    )

    if (pending.status === 'pending') {
      return yield* Effect.fail({
        error: 'authorization_pending' as const,
      } satisfies OAuthError400)
    }
    if (pending.status === 'denied') {
      return yield* Effect.fail({ error: 'access_denied' as const } satisfies OAuthError400)
    }
    if (pending.status === 'expired') {
      return yield* Effect.fail({ error: 'expired_token' as const } satisfies OAuthError400)
    }
    if (pending.status !== 'approved') {
      return yield* Effect.fail({
        error: 'invalid_grant' as const,
        error_description: 'Unsupported status',
      } satisfies OAuthError400)
    }

    // device_code is single-use: consume the row before minting so a
    // second poll returns `expired_token`. Per RFC 8628 §3.4 the device
    // code is valid only until the first successful exchange.
    store.commit(AuthorizationRequests.events.authorizationRequestExpired({ id: pending.id }))

    return yield* issueTokenResponse(store, {
      clientId: pending.clientId,
      grantedScopes: pending.grantedScopes ?? [],
      patient: pending.patient,
    })
  })

const validateClientForToken = (
  store: typeof GatekeeperStore.Service,
  clientId: string,
  clientSecret: string | undefined
): Effect.Effect<ClientRow, OAuthError401 | OAuthError500> =>
  Effect.gen(function* () {
    const client = store.query(Clients.queries.byId$(clientId))
    if (client == null) {
      return yield* Effect.fail({
        error: 'invalid_client' as const,
        error_description: 'Unknown client_id',
      } satisfies OAuthError401)
    }
    if (client.disabledAt != null) {
      return yield* Effect.fail({
        error: 'invalid_client' as const,
        error_description: 'Client is disabled',
      } satisfies OAuthError401)
    }
    if (client.kind === 'confidential') {
      if (client.secretHash == null) {
        return yield* Effect.fail({
          error: 'invalid_client' as const,
          error_description: 'Client secret not configured',
        } satisfies OAuthError401)
      }
      if (clientSecret == null) {
        return yield* Effect.fail({
          error: 'invalid_client' as const,
          error_description: 'Client secret required',
        } satisfies OAuthError401)
      }
      const presentedHash = yield* sha256Hex(clientSecret).pipe(
        Effect.mapError(
          () =>
            ({
              error: 'server_error' as const,
              error_description: 'Failed to hash client_secret',
            }) satisfies OAuthError500
        )
      )
      if (!timingSafeEqual(presentedHash, client.secretHash)) {
        return yield* Effect.fail({
          error: 'invalid_client' as const,
          error_description: 'Invalid client_secret',
        } satisfies OAuthError401)
      }
    }
    return client
  })

const issueTokenResponse = (
  store: typeof GatekeeperStore.Service,
  payload: { clientId: string; grantedScopes: ReadonlyArray<string>; patient: string | null }
): Effect.Effect<TokenResponse, OAuthError500, Origin> =>
  Effect.gen(function* () {
    const activeKey = store.query(SigningKeys.queries.active$)
    const allKeys = store.query(SigningKeys.queries.all$)
    const signingKey = activeKey ?? allKeys[0]
    if (signingKey === undefined) {
      return yield* Effect.fail({
        error: 'server_error' as const,
        error_description: 'No JSON Web Keys available to sign token',
      } satisfies OAuthError500)
    }

    const origin = yield* Origin
    const signedToken = yield* mintAccessToken(signingKey, origin, {
      clientId: payload.clientId,
      scope: payload.grantedScopes,
      ttlSeconds: 60 * 60,
      audience: `${origin}/fhir`,
      patient: payload.patient,
    }).pipe(
      Effect.mapError(
        () =>
          ({
            error: 'server_error' as const,
            error_description: 'Failed to sign JWT',
          }) satisfies OAuthError500
      )
    )

    const grantedScope = payload.grantedScopes.join(' ')
    return {
      access_token: signedToken,
      token_type: 'Bearer',
      expires_in: 60 * 60,
      scope: grantedScope,
      patient: payload.patient ?? undefined,
    } satisfies TokenResponse
  })

const generateUniqueUserCode = (store: typeof GatekeeperStore.Service): string => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateUserCode()
    const existing = store.query(AuthorizationRequests.queries.byUserCode$(candidate))
    if (existing == null || existing.status !== 'pending') return candidate
  }
  throw new Error('Could not generate a unique user_code after 10 attempts')
}

const sha256Hex = (input: string): Effect.Effect<string, Error> =>
  Effect.tryPromise(async () => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  })

export { httpApiGroup, layer, sha256Hex }
