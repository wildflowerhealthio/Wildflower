import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import type { Schema } from 'effect'
import { Array, DateTime, Duration, Effect, pipe } from 'effect'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import type {
  AuthorizationCodePayload,
  DeviceCodePayload,
  OAuthError400Schema,
  OAuthError401Schema,
  OAuthError500Schema,
  AuthorizationStatusNotFoundSchema,
} from '../http-api-definition/oauth.ts'
import { httpApiGroup } from '../http-api-definition/oauth.ts'
import { oauthErrorHtml } from '../internal/error-pages.ts'
import { mintAccessToken } from '../internal/jwt.ts'
import { computeCodeChallenge } from '../internal/pkce.ts'
import { timingSafeEqual } from '../internal/timing-safe-equal.ts'
import { generateUserCode } from '../internal/user-code.ts'
import {
  AuthorizationCodes,
  type AuthorizationCodeRow,
  AuthorizationRequests,
  type AuthorizationRequestRow,
  Clients,
  type ClientRow,
  Grants,
  type SigningKey,
  SigningKeys,
} from '../livestore/index.ts'

const DEVICE_CODE_POLL_INTERVAL: Duration.Duration = Duration.seconds(5)
const DEVICE_AUTHORIZATION_TTL: Duration.Duration = Duration.minutes(5)
const AUTHORIZATION_CODE_TTL: Duration.Duration = Duration.seconds(60)
const AUTHORIZATION_REQUEST_TTL: Duration.Duration = Duration.minutes(5)
const ACCESS_TOKEN_TTL: Duration.Duration = Duration.hours(1)

// Error types derive from the wire schemas in `http-api-definition/oauth.ts`
// so a literal added there flows through here automatically.
type OAuthError400 = Schema.Schema.Type<typeof OAuthError400Schema>
type OAuthError401 = Schema.Schema.Type<typeof OAuthError401Schema>
type OAuthError500 = Schema.Schema.Type<typeof OAuthError500Schema>
type AuthorizationStatusNotFound = Schema.Schema.Type<typeof AuthorizationStatusNotFoundSchema>
type TokenExchangePayload = Schema.Schema.Type<
  typeof AuthorizationCodePayload | typeof DeviceCodePayload
>
type AuthorizationCodeExchange = Schema.Schema.Type<typeof AuthorizationCodePayload>
type DeviceCodeExchange = Schema.Schema.Type<typeof DeviceCodePayload>

type TokenResponse = {
  readonly access_token: string
  readonly token_type: string
  readonly expires_in: number
  readonly scope: string
  readonly patient: string | null | undefined
}

const oauthError400 = (error: OAuthError400['error'], description?: string): OAuthError400 =>
  description === undefined ? { error } : { error, error_description: description }

const oauthError401 = (description?: string): OAuthError401 =>
  description === undefined
    ? { error: 'invalid_client' }
    : { error: 'invalid_client', error_description: description }

const oauthError500 = (description: string): OAuthError500 => ({
  error: 'server_error',
  error_description: description,
})

const htmlErrorResponse = (html: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(html, { status: 400, contentType: 'text/html; charset=utf-8' })

// `AuthorizeUrlParams` are validated for non-emptiness by the schema; the
// payload-validation steps below add the application-level guards.

type AuthorizeParams = {
  readonly code_challenge_method: string
  readonly client_id: string
  readonly scope: string
  readonly code_challenge: string
  readonly redirect_uri: string
  readonly state: string
}

const requireSigningKey = (): Effect.Effect<
  void,
  HttpServerResponse.HttpServerResponse,
  GatekeeperStore
> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const signingKeys = store.query(SigningKeys.queries.all$)
    if (!Array.isNonEmptyReadonlyArray(signingKeys)) {
      yield* Effect.fail(HttpServerResponse.empty({ status: 503 }))
    }
  })

const requireS256ChallengeMethod = (
  method: string
): Effect.Effect<void, HttpServerResponse.HttpServerResponse> =>
  method === 'S256'
    ? Effect.void
    : Effect.fail(htmlErrorResponse(oauthErrorHtml('unsupported_code_challenge', method)))

const parseRedirectUri = (
  rawRedirectUri: string
): Effect.Effect<URL, HttpServerResponse.HttpServerResponse> =>
  Effect.try({
    try: () => new URL(rawRedirectUri),
    catch: () => htmlErrorResponse(oauthErrorHtml('invalid_redirect_uri')),
  }).pipe(
    Effect.flatMap((url) =>
      url.protocol === 'http:' || url.protocol === 'https:'
        ? Effect.succeed(url)
        : Effect.fail(htmlErrorResponse(oauthErrorHtml('invalid_scheme')))
    )
  )

const requireRegisteredEnabledClient = (
  clientId: string
): Effect.Effect<ClientRow, HttpServerResponse.HttpServerResponse, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const client = store.query(Clients.queries.byId$(clientId))
    if (client == null) {
      return yield* Effect.fail(htmlErrorResponse(oauthErrorHtml('unknown_client')))
    }
    if (client.disabledAt != null) {
      return yield* Effect.fail(htmlErrorResponse(oauthErrorHtml('disabled_client')))
    }
    return client
  })

const requireRedirectUriOnAllowlist = (
  client: ClientRow,
  rawRedirectUri: string
): Effect.Effect<void, HttpServerResponse.HttpServerResponse> =>
  client.redirectUris.includes(rawRedirectUri)
    ? Effect.void
    : Effect.fail(htmlErrorResponse(oauthErrorHtml('redirect_uri_not_allowed')))

const requireScopesAllowed = (
  client: ClientRow,
  requestedScopes: ReadonlyArray<string>
): Effect.Effect<void, HttpServerResponse.HttpServerResponse> => {
  const allowed = new Set(client.allowedScopes)
  return requestedScopes.every((s) => allowed.has(s))
    ? Effect.void
    : Effect.fail(htmlErrorResponse(oauthErrorHtml('scope_not_allowed')))
}

const startCodeAuthorizationRequest = (input: {
  requestId: string
  clientId: string
  requestedScopes: ReadonlyArray<string>
  codeChallenge: string
  redirectUri: string
  clientState: string
  preApprovedScopes: ReadonlyArray<string> | null
}): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const requestedAt = yield* DateTime.now
    const expiresAt = DateTime.addDuration(requestedAt, AUTHORIZATION_REQUEST_TTL)
    store.commit(
      AuthorizationRequests.events.authorizationRequestStarted({
        id: input.requestId,
        clientId: input.clientId,
        requestedScopes: input.requestedScopes,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: 'S256',
        redirectUri: input.redirectUri,
        clientState: input.clientState,
        preApprovedScopes: input.preApprovedScopes,
        requestedAt,
        expiresAt,
      })
    )
  })

const issueCodeForAutoApprovedRequest = (input: {
  requestId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  grantedScopes: ReadonlyArray<string>
  patient: string | null
}): Effect.Effect<string, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const code = crypto.randomUUID()
    const issuedAt = yield* DateTime.now
    const expiresAt = DateTime.addDuration(issuedAt, AUTHORIZATION_CODE_TTL)
    store.commit(
      AuthorizationRequests.events.authorizationRequestApproved({
        id: input.requestId,
        grantedScopes: input.grantedScopes,
        patient: input.patient,
      }),
      AuthorizationCodes.events.authorizationCodeIssued({
        code,
        requestId: input.requestId,
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        grantedScopes: input.grantedScopes,
        patient: input.patient,
        issuedAt,
        expiresAt,
      })
    )
    return code
  })

// Builds the OAuth client redirect carrying `code` + `state`. Kept next
// to the other URL-construction helpers in this file. There is no
// HttpApi-driven URL-builder for arbitrary client redirects (the target
// is a third-party URL, not an endpoint we serve), so manual `URL`
// assembly is unavoidable.
const buildClientRedirectUrl = (redirectUri: string, code: string, clientState: string): string => {
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  url.searchParams.set('state', clientState)
  return url.toString()
}

const buildPollingPageUrl = (origin: string, requestId: string): string =>
  `${origin}/oauth/authorize/${requestId}/view`

const handleAuthorize = (
  urlParams: AuthorizeParams
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, GatekeeperStore | Origin> => {
  const requestedScopes = urlParams.scope.split(' ').filter(Boolean)
  return pipe(
    Effect.gen(function* () {
      yield* requireSigningKey()
      yield* requireS256ChallengeMethod(urlParams.code_challenge_method)
      yield* parseRedirectUri(urlParams.redirect_uri)
      const client = yield* requireRegisteredEnabledClient(urlParams.client_id)
      yield* requireRedirectUriOnAllowlist(client, urlParams.redirect_uri)
      yield* requireScopesAllowed(client, requestedScopes)

      const store = yield* GatekeeperStore
      const approvedGrant = store.query(
        Grants.queries.byClientIdAndRedirectUri$(urlParams.client_id, urlParams.redirect_uri)
      )
      const previouslyApproved = new Set<string>(approvedGrant?.scopes ?? [])
      const preApproved = requestedScopes.filter((s) => previouslyApproved.has(s))

      const requestId = crypto.randomUUID()
      yield* startCodeAuthorizationRequest({
        requestId,
        clientId: urlParams.client_id,
        requestedScopes,
        codeChallenge: urlParams.code_challenge,
        redirectUri: urlParams.redirect_uri,
        clientState: urlParams.state,
        preApprovedScopes: preApproved.length > 0 ? preApproved : null,
      })

      const allScopesPreapproved =
        approvedGrant != null && requestedScopes.every((s) => previouslyApproved.has(s))
      if (allScopesPreapproved) {
        const code = yield* issueCodeForAutoApprovedRequest({
          requestId,
          clientId: urlParams.client_id,
          redirectUri: urlParams.redirect_uri,
          codeChallenge: urlParams.code_challenge,
          grantedScopes: requestedScopes,
          patient: approvedGrant.patient ?? null,
        })
        return HttpServerResponse.redirect(
          buildClientRedirectUrl(urlParams.redirect_uri, code, urlParams.state),
          { status: 302 }
        )
      }

      const origin = yield* Origin
      return HttpServerResponse.redirect(buildPollingPageUrl(origin, requestId), { status: 302 })
    }),
    // Validation steps short-circuit by failing with a fully-formed
    // response; surface that response to the framework as success.
    Effect.catchAll((response: HttpServerResponse.HttpServerResponse) => Effect.succeed(response))
  )
}

// --- AuthorizationStatus -----------------------------------------------------

type AuthorizationStatus =
  | { readonly status: 'pending' }
  | { readonly status: 'denied' }
  | { readonly status: 'approved'; readonly redirect: string }
  | { readonly status: 'error'; readonly message: string }

const getAuthorizationRequestForStatus = (
  id: string
): Effect.Effect<AuthorizationRequestRow, AuthorizationStatusNotFound, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const request = store.query(AuthorizationRequests.queries.byId$(id))
    if (request == null) {
      return yield* Effect.fail({
        error: 'AuthorizationRequestNotFound' as const,
        id,
      })
    }
    return request
  })

const renderAuthorizationStatus = (
  request: AuthorizationRequestRow
): Effect.Effect<AuthorizationStatus, OAuthError500, GatekeeperStore> =>
  Effect.gen(function* () {
    if (request.status === 'denied') {
      return { status: 'denied' as const }
    }
    if (request.status === 'expired') {
      return { status: 'error' as const, message: 'Authorization request expired' }
    }
    if (request.status !== 'approved') {
      return { status: 'pending' as const }
    }
    if (request.redirectUri == null || request.clientState == null) {
      return yield* Effect.fail(oauthError500('Authorization request is not a code-flow request'))
    }
    const store = yield* GatekeeperStore
    const issuedCode = store.query(AuthorizationCodes.queries.byRequestId$(request.id))
    if (issuedCode == null) {
      return yield* Effect.fail(oauthError500('Authorization code missing'))
    }
    return {
      status: 'approved' as const,
      redirect: buildClientRedirectUrl(request.redirectUri, issuedCode.code, request.clientState),
    }
  })

// --- TokenExchange (authorization_code grant) -------------------------------

const requireValidClientForToken = (
  clientId: string,
  clientSecret: string | undefined
): Effect.Effect<ClientRow, OAuthError401 | OAuthError500, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const client = store.query(Clients.queries.byId$(clientId))
    if (client == null) return yield* Effect.fail(oauthError401('Unknown client_id'))
    if (client.disabledAt != null) return yield* Effect.fail(oauthError401('Client is disabled'))
    if (client.kind === 'public') return client
    if (client.secretHash == null) {
      return yield* Effect.fail(oauthError401('Client secret not configured'))
    }
    if (clientSecret == null) {
      return yield* Effect.fail(oauthError401('Client secret required'))
    }
    const presentedHash = yield* sha256Hex(clientSecret).pipe(
      Effect.mapError(() => oauthError500('Failed to hash client_secret'))
    )
    if (!timingSafeEqual(presentedHash, client.secretHash)) {
      return yield* Effect.fail(oauthError401('Invalid client_secret'))
    }
    return client
  })

const getIssuedAuthorizationCode = (
  code: string
): Effect.Effect<AuthorizationCodeRow, OAuthError400, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const issued = store.query(AuthorizationCodes.queries.byCode$(code))
    if (issued == null) {
      return yield* Effect.fail(oauthError400('invalid_request', 'Invalid code parameter'))
    }
    return issued
  })

const requireCodeMatchesClient = (
  issuedCode: AuthorizationCodeRow,
  clientId: string
): Effect.Effect<void, OAuthError400> =>
  issuedCode.clientId === clientId
    ? Effect.void
    : Effect.fail(oauthError400('invalid_request', 'Invalid client_id parameter'))

const requireCodeMatchesRedirectUri = (
  issuedCode: AuthorizationCodeRow,
  redirectUri: string
): Effect.Effect<void, OAuthError400> =>
  issuedCode.redirectUri === redirectUri
    ? Effect.void
    : Effect.fail(oauthError400('invalid_request', 'Invalid redirect_uri parameter'))

const requireCodeNotExpired = (
  issuedCode: AuthorizationCodeRow
): Effect.Effect<void, OAuthError400> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    if (DateTime.lessThan(issuedCode.expiresAt, now)) {
      yield* Effect.fail(oauthError400('invalid_request', 'Code has expired'))
    }
  })

const requireValidCodeVerifier = (
  issuedCode: AuthorizationCodeRow,
  codeVerifier: string
): Effect.Effect<void, OAuthError400 | OAuthError500> =>
  Effect.gen(function* () {
    const computed = yield* computeCodeChallenge(codeVerifier).pipe(
      Effect.mapError(() => oauthError500('Failed to compute code challenge'))
    )
    if (!timingSafeEqual(issuedCode.codeChallenge, computed)) {
      yield* Effect.fail(oauthError400('invalid_request', 'Invalid code_verifier parameter'))
    }
  })

const consumeAuthorizationCode = (code: string): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
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

// --- TokenExchange (device_code grant) --------------------------------------

const getPendingDeviceCodeRequest = (
  deviceCode: string,
  clientId: string
): Effect.Effect<AuthorizationRequestRow, OAuthError400, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const pending = store.query(AuthorizationRequests.queries.byId$(deviceCode))
    if (pending == null || pending.grantType !== 'device_code' || pending.clientId !== clientId) {
      return yield* Effect.fail(oauthError400('invalid_grant', 'Unknown device_code'))
    }
    return pending
  })

const requireDeviceCodeNotExpired = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, OAuthError400> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    if (DateTime.lessThan(pending.expiresAt, now)) {
      yield* Effect.fail(oauthError400('expired_token'))
    }
  })

const requireDevicePollIntervalElapsed = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, OAuthError400> =>
  Effect.gen(function* () {
    if (pending.lastPolledAt == null) return
    const now = yield* DateTime.now
    const sinceLastPoll = Duration.millis(DateTime.distance(pending.lastPolledAt, now))
    if (Duration.lessThan(sinceLastPoll, DEVICE_CODE_POLL_INTERVAL)) {
      yield* Effect.fail(oauthError400('slow_down'))
    }
  })

const recordDevicePoll = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const polledAt = yield* DateTime.now
    store.commit(
      AuthorizationRequests.events.deviceAuthorizationPolled({ id: pending.id, polledAt })
    )
  })

const requireDeviceConsentResolved = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, OAuthError400> => {
  if (pending.status === 'pending') {
    return Effect.fail(oauthError400('authorization_pending'))
  }
  if (pending.status === 'denied') {
    return Effect.fail(oauthError400('access_denied'))
  }
  if (pending.status === 'expired') {
    return Effect.fail(oauthError400('expired_token'))
  }
  if (pending.status !== 'approved') {
    return Effect.fail(oauthError400('invalid_grant', 'Unsupported status'))
  }
  return Effect.void
}

const consumeDeviceCode = (
  pending: AuthorizationRequestRow
): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    // device_code is single-use per RFC 8628 §3.4: mark expired so a
    // second poll returns expired_token rather than re-issuing a token.
    store.commit(AuthorizationRequests.events.authorizationRequestExpired({ id: pending.id }))
  })

const handleDeviceCodeTokenExchange = (
  payload: DeviceCodeExchange
): Effect.Effect<
  TokenResponse,
  OAuthError400 | OAuthError401 | OAuthError500,
  GatekeeperStore | Origin
> =>
  Effect.gen(function* () {
    yield* requireValidClientForToken(payload.client_id, payload.client_secret)
    const pending = yield* getPendingDeviceCodeRequest(payload.device_code, payload.client_id)
    yield* requireDeviceCodeNotExpired(pending)
    yield* requireDevicePollIntervalElapsed(pending)
    yield* recordDevicePoll(pending)
    yield* requireDeviceConsentResolved(pending)
    yield* consumeDeviceCode(pending)
    return yield* issueTokenResponse({
      clientId: pending.clientId,
      grantedScopes: pending.grantedScopes ?? [],
      patient: pending.patient,
    })
  })

const handleTokenExchange = (
  payload: TokenExchangePayload
): Effect.Effect<
  TokenResponse,
  OAuthError400 | OAuthError401 | OAuthError500,
  GatekeeperStore | Origin
> =>
  payload.grant_type === 'urn:ietf:params:oauth:grant-type:device_code'
    ? handleDeviceCodeTokenExchange(payload)
    : handleAuthorizationCodeTokenExchange(payload)

// --- DeviceAuthorization ----------------------------------------------------

type DeviceAuthorizationResponse = {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string
  readonly expires_in: number
  readonly interval: number
}

type DeviceAuthorizationPayload = {
  readonly client_id: string
  readonly scope?: string
}

const requireValidDeviceAuthorizationClient = (
  clientId: string,
  requestedScopes: ReadonlyArray<string>
): Effect.Effect<ClientRow, OAuthError400 | OAuthError401, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const client = store.query(Clients.queries.byId$(clientId))
    if (client == null || client.disabledAt != null) {
      return yield* Effect.fail(oauthError401('Unknown or disabled client_id'))
    }
    const allowed = new Set(client.allowedScopes)
    if (!requestedScopes.every((s) => allowed.has(s))) {
      return yield* Effect.fail(oauthError400('invalid_scope', 'Scope not allowed for client'))
    }
    return client
  })

const generateUniqueUserCode = (store: typeof GatekeeperStore.Service): string => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateUserCode()
    const existing = store.query(AuthorizationRequests.queries.byUserCode$(candidate))
    if (existing == null || existing.status !== 'pending') return candidate
  }
  throw new Error('Could not generate a unique user_code after 10 attempts')
}

const startDeviceAuthorizationRequest = (input: {
  clientId: string
  requestedScopes: ReadonlyArray<string>
}): Effect.Effect<{ id: string; userCode: string }, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const id = crypto.randomUUID()
    const userCode = generateUniqueUserCode(store)
    const requestedAt = yield* DateTime.now
    const expiresAt = DateTime.addDuration(requestedAt, DEVICE_AUTHORIZATION_TTL)
    store.commit(
      AuthorizationRequests.events.deviceAuthorizationRequestStarted({
        id,
        clientId: input.clientId,
        requestedScopes: input.requestedScopes,
        userCode,
        requestedAt,
        expiresAt,
      })
    )
    return { id, userCode }
  })

const handleDeviceAuthorization = (
  payload: DeviceAuthorizationPayload
): Effect.Effect<
  DeviceAuthorizationResponse,
  OAuthError400 | OAuthError401,
  GatekeeperStore | Origin
> => {
  const requestedScopes = (payload.scope ?? '').split(' ').filter(Boolean)
  return Effect.gen(function* () {
    yield* requireValidDeviceAuthorizationClient(payload.client_id, requestedScopes)
    const { id, userCode } = yield* startDeviceAuthorizationRequest({
      clientId: payload.client_id,
      requestedScopes,
    })
    const origin = yield* Origin
    return {
      device_code: id,
      user_code: userCode,
      verification_uri: `${origin}/access/devices`,
      verification_uri_complete: `${origin}/access/devices?user_code=${userCode}`,
      expires_in: Math.floor(Duration.toMillis(DEVICE_AUTHORIZATION_TTL) / 1000),
      interval: Math.floor(Duration.toMillis(DEVICE_CODE_POLL_INTERVAL) / 1000),
    }
  })
}

// --- Token issuance ---------------------------------------------------------

const pickSigningKeyForMint = (): Effect.Effect<SigningKey, OAuthError500, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const active = store.query(SigningKeys.queries.active$)
    const all = store.query(SigningKeys.queries.all$)
    const chosen = active ?? all[0]
    if (chosen === undefined) {
      return yield* Effect.fail(oauthError500('No JSON Web Keys available to sign token'))
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
    }).pipe(Effect.mapError(() => oauthError500('Failed to sign JWT')))
    return {
      access_token: signed,
      token_type: 'Bearer',
      expires_in: Math.floor(Duration.toMillis(ACCESS_TOKEN_TTL) / 1000),
      scope: input.grantedScopes.join(' '),
      patient: input.patient ?? undefined,
    }
  })

const sha256Hex = (input: string): Effect.Effect<string, Error> =>
  Effect.tryPromise(async () => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  })

// --- Layer wiring -----------------------------------------------------------

const layer = HttpApiBuilder.group(GatekeeperApi, 'oauth', (handlers) =>
  handlers
    .handleRaw('Authorize', ({ urlParams }) => handleAuthorize(urlParams))
    .handle('AuthorizationStatus', ({ path: { id } }) =>
      pipe(getAuthorizationRequestForStatus(id), Effect.flatMap(renderAuthorizationStatus))
    )
    .handle('TokenExchange', ({ payload }) => handleTokenExchange(payload))
    .handle('DeviceAuthorization', ({ payload }) => handleDeviceAuthorization(payload))
)

export { httpApiGroup, layer, sha256Hex }
