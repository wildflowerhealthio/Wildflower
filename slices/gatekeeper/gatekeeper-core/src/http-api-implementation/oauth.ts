import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Array, DateTime, Effect, Schema } from 'effect'
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
  Grants,
  SigningKeys,
} from '../livestore/index.ts'

const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

const decodeAuthorizationCodePayload = Schema.decodeUnknown(
  Schema.Struct({
    client_id: Schema.NonEmptyString,
    client_secret: Schema.optional(Schema.String),
    code: Schema.NonEmptyString,
    code_verifier: Schema.String.pipe(Schema.minLength(43), Schema.maxLength(128)),
    grant_type: Schema.Literal('authorization_code'),
    redirect_uri: Schema.NonEmptyString,
  })
)

const decodeDeviceCodePayload = Schema.decodeUnknown(
  Schema.Struct({
    client_id: Schema.NonEmptyString,
    client_secret: Schema.optional(Schema.String),
    device_code: Schema.NonEmptyString,
    grant_type: Schema.Literal(DEVICE_CODE_GRANT_TYPE),
  })
)

const decodeDeviceAuthorizationPayload = Schema.decodeUnknown(
  Schema.Struct({
    client_id: Schema.NonEmptyString,
    scope: Schema.optional(Schema.String),
  })
)

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
        return HttpServerResponse.redirect(`${origin}/oauth/authorize/${requestId}/page`, {
          status: 302,
        })
      })
    )
    .handleRaw('AuthorizationStatus', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore

        const request = store.query(AuthorizationRequests.queries.byId$(id))
        if (request == null) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Unknown id' },
            { status: 404 }
          )
        }

        if (request.status === 'approved') {
          if (request.redirectUri == null || request.clientState == null) {
            return HttpServerResponse.unsafeJson(
              { status: 'error', message: 'Authorization request is not a code-flow request' },
              { status: 400 }
            )
          }
          const issuedCode = store.query(AuthorizationCodes.queries.byRequestId$(id))
          if (issuedCode == null) {
            return HttpServerResponse.unsafeJson(
              { status: 'error', message: 'Authorization code missing' },
              { status: 500 }
            )
          }
          return HttpServerResponse.unsafeJson({
            status: 'approved',
            redirect: buildClientRedirect(
              request.redirectUri,
              issuedCode.code,
              request.clientState
            ),
          })
        }

        if (request.status === 'denied') {
          return HttpServerResponse.unsafeJson({ status: 'declined' })
        }

        if (request.status === 'expired') {
          return HttpServerResponse.unsafeJson({
            status: 'error',
            message: 'Authorization request expired',
          })
        }

        return HttpServerResponse.unsafeJson({ status: 'pending' })
      })
    )
    .handleRaw('TokenExchange', ({ request }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore

        const bodyTextEither = yield* Effect.either(request.text)
        if (bodyTextEither._tag === 'Left') {
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Failed to read request body' },
            { status: 400 }
          )
        }

        const params = Object.fromEntries(new URLSearchParams(bodyTextEither.right))

        if (params['grant_type'] === DEVICE_CODE_GRANT_TYPE) {
          return yield* handleDeviceCodeTokenExchange(store, params)
        }

        return yield* handleAuthorizationCodeTokenExchange(store, params)
      })
    )
    .handleRaw('DeviceAuthorization', ({ request }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore

        const bodyTextEither = yield* Effect.either(request.text)
        if (bodyTextEither._tag === 'Left') {
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Failed to read request body' },
            { status: 400 }
          )
        }

        const parsedEither = yield* Effect.either(
          decodeDeviceAuthorizationPayload(
            Object.fromEntries(new URLSearchParams(bodyTextEither.right))
          )
        )
        if (parsedEither._tag === 'Left') {
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Invalid device authorization payload' },
            { status: 400 }
          )
        }

        const { client_id, scope } = parsedEither.right
        const requestedScopes = (scope ?? '').split(' ').filter(Boolean)

        const client = store.query(Clients.queries.byId$(client_id))
        if (client == null || client.disabledAt != null) {
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_client', error_description: 'Unknown or disabled client_id' },
            { status: 401 }
          )
        }
        const allowedScopeSet = new Set(client.allowedScopes)
        if (!requestedScopes.every((s) => allowedScopeSet.has(s))) {
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_scope', error_description: 'Scope not allowed for client' },
            { status: 400 }
          )
        }

        const requestedAt = yield* DateTime.now
        const expiresAt = DateTime.addDuration(requestedAt, '5 minutes')
        const id = crypto.randomUUID()
        const userCode = generateUniqueUserCode(store)

        store.commit(
          AuthorizationRequests.events.deviceAuthorizationRequestStarted({
            id,
            clientId: client_id,
            requestedScopes,
            userCode,
            requestedAt,
            expiresAt,
          })
        )

        const origin = yield* Origin
        return HttpServerResponse.unsafeJson({
          device_code: id,
          user_code: userCode,
          verification_uri: `${origin}/access/devices`,
          verification_uri_complete: `${origin}/access/devices?user_code=${userCode}`,
          expires_in: 300,
          interval: 5,
        })
      })
    )
)

const handleAuthorizationCodeTokenExchange = (
  store: typeof GatekeeperStore.Service,
  params: Record<string, string>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Origin> =>
  Effect.gen(function* () {
    const parsedPayloadEither = yield* Effect.either(decodeAuthorizationCodePayload(params))
    if (parsedPayloadEither._tag === 'Left') {
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_request', error_description: 'Invalid token exchange payload' },
        { status: 400 }
      )
    }

    const { client_id, client_secret, code, code_verifier, redirect_uri } =
      parsedPayloadEither.right

    const clientCheck = yield* validateClientForToken(store, client_id, client_secret)
    if (clientCheck.kind === 'error') return clientCheck.response

    const issuedCode = store.query(AuthorizationCodes.queries.byCode$(code))
    if (issuedCode == null) {
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_request', error_description: 'Invalid code parameter' },
        { status: 400 }
      )
    }

    if (issuedCode.clientId !== client_id) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_request', error_description: 'Invalid client_id parameter' },
        { status: 400 }
      )
    }

    if (issuedCode.redirectUri !== redirect_uri) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_request', error_description: 'Invalid redirect_uri parameter' },
        { status: 400 }
      )
    }

    const tokenNow = yield* DateTime.now
    if (DateTime.lessThan(issuedCode.expiresAt, tokenNow)) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_request', error_description: 'Code has expired' },
        { status: 400 }
      )
    }

    const codeChallengeEither = yield* Effect.either(computeCodeChallenge(code_verifier))
    if (codeChallengeEither._tag === 'Left') {
      return HttpServerResponse.unsafeJson(
        { error: 'server_error', error_description: 'Failed to compute code challenge' },
        { status: 500 }
      )
    }

    if (!timingSafeEqual(issuedCode.codeChallenge, codeChallengeEither.right)) {
      store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_request', error_description: 'Invalid code_verifier parameter' },
        { status: 400 }
      )
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
  params: Record<string, string>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Origin> =>
  Effect.gen(function* () {
    const parsedEither = yield* Effect.either(decodeDeviceCodePayload(params))
    if (parsedEither._tag === 'Left') {
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_request', error_description: 'Invalid token exchange payload' },
        { status: 400 }
      )
    }

    const { client_id, client_secret, device_code } = parsedEither.right

    const clientCheck = yield* validateClientForToken(store, client_id, client_secret)
    if (clientCheck.kind === 'error') return clientCheck.response

    const pending = store.query(AuthorizationRequests.queries.byId$(device_code))
    if (pending == null || pending.flow !== 'device_code' || pending.clientId !== client_id) {
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_grant', error_description: 'Unknown device_code' },
        { status: 400 }
      )
    }

    const now = yield* DateTime.now
    if (DateTime.lessThan(pending.expiresAt, now)) {
      return HttpServerResponse.unsafeJson({ error: 'expired_token' }, { status: 400 })
    }

    if (pending.status === 'pending') {
      return HttpServerResponse.unsafeJson({ error: 'authorization_pending' }, { status: 400 })
    }
    if (pending.status === 'denied') {
      return HttpServerResponse.unsafeJson({ error: 'access_denied' }, { status: 400 })
    }
    if (pending.status === 'expired') {
      return HttpServerResponse.unsafeJson({ error: 'expired_token' }, { status: 400 })
    }
    if (pending.status !== 'approved') {
      return HttpServerResponse.unsafeJson(
        { error: 'invalid_grant', error_description: 'Unsupported status' },
        { status: 400 }
      )
    }

    const grantedScopes = pending.grantedScopes ?? []
    return yield* issueTokenResponse(store, {
      clientId: pending.clientId,
      grantedScopes,
      patient: pending.patient,
    })
  })

const validateClientForToken = (
  store: typeof GatekeeperStore.Service,
  clientId: string,
  clientSecret: string | undefined
): Effect.Effect<
  { kind: 'ok' } | { kind: 'error'; response: HttpServerResponse.HttpServerResponse },
  never,
  never
> =>
  Effect.gen(function* () {
    const client = store.query(Clients.queries.byId$(clientId))
    if (client == null) {
      return {
        kind: 'error' as const,
        response: HttpServerResponse.unsafeJson(
          { error: 'invalid_client', error_description: 'Unknown client_id' },
          { status: 401 }
        ),
      }
    }
    if (client.disabledAt != null) {
      return {
        kind: 'error' as const,
        response: HttpServerResponse.unsafeJson(
          { error: 'invalid_client', error_description: 'Client is disabled' },
          { status: 401 }
        ),
      }
    }
    if (client.kind === 'confidential') {
      if (client.secretHash == null) {
        return {
          kind: 'error' as const,
          response: HttpServerResponse.unsafeJson(
            { error: 'invalid_client', error_description: 'Client secret not configured' },
            { status: 401 }
          ),
        }
      }
      if (clientSecret == null) {
        return {
          kind: 'error' as const,
          response: HttpServerResponse.unsafeJson(
            { error: 'invalid_client', error_description: 'Client secret required' },
            { status: 401 }
          ),
        }
      }
      const presentedHashEither = yield* Effect.either(sha256Hex(clientSecret))
      if (presentedHashEither._tag === 'Left') {
        return {
          kind: 'error' as const,
          response: HttpServerResponse.unsafeJson(
            { error: 'server_error', error_description: 'Failed to hash client_secret' },
            { status: 500 }
          ),
        }
      }
      if (!timingSafeEqual(presentedHashEither.right, client.secretHash)) {
        return {
          kind: 'error' as const,
          response: HttpServerResponse.unsafeJson(
            { error: 'invalid_client', error_description: 'Invalid client_secret' },
            { status: 401 }
          ),
        }
      }
    }
    return { kind: 'ok' as const }
  })

const issueTokenResponse = (
  store: typeof GatekeeperStore.Service,
  payload: { clientId: string; grantedScopes: ReadonlyArray<string>; patient: string | null }
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Origin> =>
  Effect.gen(function* () {
    const activeKey = store.query(SigningKeys.queries.active$)
    const allKeys = store.query(SigningKeys.queries.all$)
    const signingKey = activeKey ?? allKeys[0]
    if (signingKey === undefined) {
      return HttpServerResponse.unsafeJson(
        { error: 'server_error', error_description: 'No JSON Web Keys available to sign token' },
        { status: 500 }
      )
    }

    const origin = yield* Origin
    const signedTokenEither = yield* Effect.either(
      mintAccessToken(signingKey, origin, {
        clientId: payload.clientId,
        scope: payload.grantedScopes,
        ttlSeconds: 60 * 60,
        audience: `${origin}/fhir`,
        patient: payload.patient,
      })
    )
    if (signedTokenEither._tag === 'Left') {
      return HttpServerResponse.unsafeJson(
        { error: 'server_error', error_description: 'Failed to sign JWT' },
        { status: 500 }
      )
    }

    const grantedScope = payload.grantedScopes.join(' ')
    const tokenResponse: Record<string, unknown> = {
      access_token: signedTokenEither.right,
      token_type: 'Bearer',
      expires_in: 60 * 60,
      scope: grantedScope,
    }
    if (payload.patient != null) {
      tokenResponse.patient = payload.patient
    }
    return HttpServerResponse.unsafeJson(tokenResponse, {
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    })
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
