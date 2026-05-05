import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Array, Clock, DateTime, Effect, Schema } from 'effect'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import { OAuthDisplayDefault } from '../contexts/oauth-display-default.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { httpApiGroup } from '../http-api-definition/oauth.ts'
import { oauthErrorHtml } from '../internal/error-pages.ts'
import { computeCodeChallenge } from '../internal/pkce.ts'
import { timingSafeEqual } from '../internal/timing-safe-equal.ts'
import {
  AuthorizationCodes,
  AuthorizationRequests,
  Grants,
  SigningKeys,
} from '../livestore/index.ts'

const decodeTokenExchangePayload = Schema.decodeUnknown(
  Schema.Struct({
    client_id: Schema.NonEmptyString,
    code: Schema.NonEmptyString,
    code_verifier: Schema.NonEmptyString,
    grant_type: Schema.Literal('authorization_code'),
    redirect_uri: Schema.NonEmptyString,
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

        const { code_challenge_method, client_id, scope, code_challenge, redirect_uri, display } =
          urlParams
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

        const requestId = crypto.randomUUID()

        const requestedScopes = scope.split(' ').filter(Boolean)
        const approvedGrant = store
          .query(Grants.queries.byClientId$(client_id))
          .find((grant) => grant.redirectUri === redirect_uri)

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

        if (approvedGrant !== undefined) {
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
        const displayDefault = yield* OAuthDisplayDefault
        // URL param keeps the OAuth client-facing literal `'polling'`; we
        // translate to the internal `'out-of-band-polling'` mode here.
        let effectiveDisplay: 'interactive' | 'out-of-band-polling' = displayDefault
        if (display === 'polling') effectiveDisplay = 'out-of-band-polling'

        if (effectiveDisplay === 'out-of-band-polling') {
          return HttpServerResponse.redirect(`${origin}/oauth/authorize/${requestId}/page`, {
            status: 302,
          })
        }

        return HttpServerResponse.redirect(`${origin}/access/oauth-consents/${requestId}/ui`, {
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

        const [jwk] = store.query(SigningKeys.queries.all$)
        if (jwk === undefined) {
          return HttpServerResponse.unsafeJson(
            {
              error: 'server_error',
              error_description: 'No JSON Web Keys available to sign token',
            },
            { status: 500 }
          )
        }

        store.commit(AuthorizationCodes.events.authorizationCodeConsumed({ code }))

        const origin = yield* Origin
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
        const grantedScope = issuedCode.grantedScopes.join(' ')
        const jwtPayload: Record<string, unknown> = {
          iss: origin,
          sub: issuedCode.clientId,
          aud: `${origin}/fhir`,
          exp: now + 3600,
          iat: now,
          scope: grantedScope,
          type: 'access_token',
        }
        if (issuedCode.patient != null) {
          jwtPayload.patient = issuedCode.patient
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
          scope: grantedScope,
        }

        if (issuedCode.patient != null) {
          tokenResponse.patient = issuedCode.patient
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
