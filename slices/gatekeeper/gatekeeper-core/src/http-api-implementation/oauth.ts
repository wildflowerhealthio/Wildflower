import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Array, DateTime, Effect, Schema } from 'effect'
import { Origin } from 'kitchen-sink'
import { approveAuthRequest, notifyAuthRequestListeners } from '../contexts/AuthListeners.ts'
import { AuthRenderer } from '../contexts/AuthRenderer.ts'
import { AuthStore } from '../contexts/AuthStore.ts'
import { OAuthDisplayDefault } from '../contexts/OAuthDisplayDefault.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import { httpApiGroup } from '../http-api-definition/oauth.ts'
import { computeCodeChallenge } from '../internal/pkce.ts'
import { timingSafeEqual } from '../internal/timing-safe-equal.ts'
import { AuthCodes, Clients, JsonWebKeys } from '../livestore/index.ts'

const decodeTokenExchangePayload = Schema.decodeUnknown(
  Schema.Struct({
    client_id: Schema.NonEmptyString,
    code: Schema.NonEmptyString,
    code_verifier: Schema.NonEmptyString,
    grant_type: Schema.Literal('authorization_code'),
    redirect_uri: Schema.NonEmptyString,
  })
)

const layer = HttpApiBuilder.group(AuthApi, 'oauth', (handlers) =>
  handlers
    .handleRaw('Authorize', ({ urlParams }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        const renderer = yield* AuthRenderer

        const jsonWebKeys = store.query(JsonWebKeys.queries.allJwks$)
        if (!Array.isNonEmptyReadonlyArray(jsonWebKeys)) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: `No JSON Web Keys available` },
            { status: 503 }
          )
        }

        const { code_challenge_method, client_id, scope, code_challenge, redirect_uri, display } =
          urlParams
        const stateParam = urlParams.state

        if (code_challenge_method !== 'S256') {
          return renderer.oauthError({
            kind: 'unsupported_code_challenge',
            method: code_challenge_method,
          })
        }

        let parsedRedirect: URL
        try {
          parsedRedirect = new URL(redirect_uri)
        } catch {
          return renderer.oauthError({ kind: 'invalid_redirect_uri' })
        }

        if (parsedRedirect.protocol !== 'http:' && parsedRedirect.protocol !== 'https:') {
          return renderer.oauthError({ kind: 'invalid_scheme' })
        }

        const code = crypto.randomUUID()

        const requestedScopes = scope.split(' ').filter(Boolean)
        const approvedClient = store
          .query(Clients.queries.byClientId$(client_id))
          .find((client) => client.redirectUri === redirect_uri)

        const previouslyApproved = new Set<string>(approvedClient?.scopes ?? [])
        const preApproved = requestedScopes.filter((requested) => previouslyApproved.has(requested))
        let preApprovedToPersist: ReadonlyArray<string> | null = null
        if (preApproved.length > 0) {
          preApprovedToPersist = preApproved
        }

        store.commit(
          AuthCodes.events.authCodeCreated({
            code,
            clientId: client_id,
            scope,
            codeChallenge: code_challenge,
            redirectUri: redirect_uri,
            state: stateParam,
            exp: DateTime.addDuration(DateTime.unsafeNow(), '5 minutes'),
            preApprovedScopes: preApprovedToPersist,
          })
        )

        if (approvedClient !== undefined) {
          const allScopesApproved = requestedScopes.every((requested) =>
            previouslyApproved.has(requested)
          )
          if (allScopesApproved) {
            const redirect = approveAuthRequest(
              store,
              code,
              requestedScopes,
              approvedClient.patient ?? undefined
            )
            if (redirect != null) {
              store.commit(AuthCodes.events.authCodeDeleted({ code }))
              return HttpServerResponse.redirect(redirect, { status: 302 })
            }
          }
        }

        const created = store.query(AuthCodes.queries.byCode$(code))
        if (created != null) {
          notifyAuthRequestListeners(created)
        }

        const origin = yield* Origin
        const displayDefault = yield* OAuthDisplayDefault
        const effectiveDisplay = display ?? displayDefault

        if (effectiveDisplay === 'polling') {
          return renderer.oauthPollingPage({
            code,
            clientId: client_id,
            statusUrl: `${origin}/auth/status/${code}`,
          })
        }

        return HttpServerResponse.redirect(`${origin}/auth/ui/authorization_request/${code}`, {
          status: 302,
        })
      })
    )
    .handleRaw('AuthorizeStatus', ({ path: { code } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore

        const pending = store.query(AuthCodes.queries.byCode$(code))
        if (pending == null) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Unknown code' },
            { status: 404 }
          )
        }

        if (pending.status === 'approved') {
          const redirect = new URL(pending.redirectUri)
          redirect.searchParams.set('code', code)
          redirect.searchParams.set('state', pending.state)
          return HttpServerResponse.unsafeJson({
            status: 'approved',
            redirect: redirect.toString(),
          })
        }

        return HttpServerResponse.unsafeJson({ status: 'pending' })
      })
    )
    .handleRaw('TokenExchange', ({ request }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore

        const bodyTextEither = yield* Effect.either(request.text)
        if (bodyTextEither._tag === 'Left') {
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Failed to read request body' },
            { status: 400 }
          )
        }

        const parsedPayloadEither = yield* Effect.either(
          decodeTokenExchangePayload(Object.fromEntries(new URLSearchParams(bodyTextEither.right)))
        )
        if (parsedPayloadEither._tag === 'Left') {
          return HttpServerResponse.unsafeJson(
            {
              error: 'invalid_request',
              error_description: 'Invalid token exchange payload',
            },
            { status: 400 }
          )
        }

        const { client_id, code, code_verifier, redirect_uri } = parsedPayloadEither.right

        const previous = store.query(AuthCodes.queries.byCode$(code))
        if (previous == null) {
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Invalid code parameter' },
            { status: 400 }
          )
        }

        if (previous.clientId !== client_id) {
          store.commit(AuthCodes.events.authCodeDeleted({ code }))
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Invalid client_id parameter' },
            { status: 400 }
          )
        }

        if (previous.redirectUri !== redirect_uri) {
          store.commit(AuthCodes.events.authCodeDeleted({ code }))
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Invalid redirect_uri parameter' },
            { status: 400 }
          )
        }

        if (DateTime.lessThan(previous.exp, DateTime.unsafeNow())) {
          store.commit(AuthCodes.events.authCodeDeleted({ code }))
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Code has expired' },
            { status: 400 }
          )
        }

        if (previous.approvedScopes == null) {
          store.commit(AuthCodes.events.authCodeDeleted({ code }))
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_grant', error_description: 'Authorization not approved' },
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

        if (!timingSafeEqual(previous.codeChallenge, codeChallengeEither.right)) {
          store.commit(AuthCodes.events.authCodeDeleted({ code }))
          return HttpServerResponse.unsafeJson(
            { error: 'invalid_request', error_description: 'Invalid code_verifier parameter' },
            { status: 400 }
          )
        }

        const [jwk] = store.query(JsonWebKeys.queries.allJwks$)
        if (jwk === undefined) {
          return HttpServerResponse.unsafeJson(
            {
              error: 'server_error',
              error_description: 'No JSON Web Keys available to sign token',
            },
            { status: 500 }
          )
        }

        store.commit(AuthCodes.events.authCodeDeleted({ code }))

        const origin = yield* Origin
        const now = Math.floor(Date.now() / 1000)
        const jwtPayload: Record<string, unknown> = {
          iss: `${origin}/fhir`,
          sub: previous.clientId,
          aud: `${origin}/fhir`,
          exp: now + 3600,
          iat: now,
          scope: previous.scope,
        }
        if (previous.patient != null) {
          jwtPayload.patient = previous.patient
        }

        const signedTokenEither = yield* Effect.either(
          Effect.tryPromise(() => jwk.signJwt(jwtPayload))
        )
        if (signedTokenEither._tag === 'Left') {
          return HttpServerResponse.unsafeJson(
            { error: 'server_error', error_description: 'Failed to sign JWT' },
            { status: 500 }
          )
        }

        const tokenResponse: Record<string, unknown> = {
          access_token: signedTokenEither.right,
          token_type: 'Bearer',
          expires_in: 60 * 60,
          scope: previous.scope,
        }

        if (previous.patient != null) {
          tokenResponse.patient = previous.patient
        }

        return HttpServerResponse.unsafeJson(tokenResponse, {
          headers: {
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
          },
        })
      })
    )
)

export { httpApiGroup, layer }
