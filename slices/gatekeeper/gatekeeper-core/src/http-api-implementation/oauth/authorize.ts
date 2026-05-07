import { HttpServerResponse } from '@effect/platform'
import type { Schema } from 'effect'
import { Array, DateTime, Duration, Effect, pipe } from 'effect'
import type { Origin } from 'kitchen-sink'
import { CryptoRandom } from 'kitchen-sink/crypto-random'
import { GatekeeperStore } from '../../contexts/gatekeeper-store.ts'
import type { AuthorizeUrlParamsSchema } from '../../http-api-definition/oauth.ts'
import { oauthErrorHtml } from '../../internal/error-pages.ts'
import {
  AuthorizationCode,
  AuthorizationRequest,
  Client,
  type ClientRow,
  Grant,
  SigningKey,
} from '../../livestore/index.ts'
import * as GatekeeperPaths from '../../page-paths.ts'
import { buildClientRedirectUrl } from './shared.ts'

type AuthorizeParams = Schema.Schema.Type<typeof AuthorizeUrlParamsSchema>

const AUTHORIZATION_CODE_TTL: Duration.Duration = Duration.seconds(60)
const AUTHORIZATION_REQUEST_TTL: Duration.Duration = Duration.minutes(5)

const htmlBadRequestResponse = (html: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(html, { status: 400, contentType: 'text/html; charset=utf-8' })

// `AuthorizeUrlParams` are validated for non-emptiness by the schema; the
// payload-validation steps below add the application-level guards.

const requireSigningKey = (): Effect.Effect<
  void,
  HttpServerResponse.HttpServerResponse,
  GatekeeperStore
> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const signingKeys = store.query(SigningKey.queries.all$)
    if (!Array.isNonEmptyReadonlyArray(signingKeys)) {
      yield* Effect.fail(HttpServerResponse.empty({ status: 503 }))
    }
  })

const requireS256ChallengeMethod = (
  method: string
): Effect.Effect<void, HttpServerResponse.HttpServerResponse> => {
  if (method === 'S256') return Effect.void
  return Effect.fail(htmlBadRequestResponse(oauthErrorHtml('unsupported_code_challenge', method)))
}

const requireHttpScheme = (url: URL): Effect.Effect<URL, HttpServerResponse.HttpServerResponse> => {
  if (url.protocol === 'http:' || url.protocol === 'https:') return Effect.succeed(url)
  return Effect.fail(htmlBadRequestResponse(oauthErrorHtml('invalid_scheme')))
}

const parseRedirectUri = (
  rawRedirectUri: string
): Effect.Effect<URL, HttpServerResponse.HttpServerResponse> =>
  Effect.try({
    try: () => new URL(rawRedirectUri),
    catch: () => htmlBadRequestResponse(oauthErrorHtml('invalid_redirect_uri')),
  }).pipe(Effect.flatMap(requireHttpScheme))

// Authorize-flow client lookup: returns the row narrowed to "enabled"
// (`disabledAt: null`) so callers don't repeat the null-check.
const getEnabledClient = (
  clientId: string
): Effect.Effect<
  ClientRow & { disabledAt: null },
  HttpServerResponse.HttpServerResponse,
  GatekeeperStore
> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const client = store.query(Client.queries.byId$(clientId))
    if (client == null) {
      return yield* Effect.fail(htmlBadRequestResponse(oauthErrorHtml('unknown_client')))
    }
    if (client.disabledAt != null) {
      return yield* Effect.fail(htmlBadRequestResponse(oauthErrorHtml('disabled_client')))
    }
    return { ...client, disabledAt: null }
  })

const requireRedirectUriOnAllowlist = (
  client: ClientRow,
  rawRedirectUri: string
): Effect.Effect<void, HttpServerResponse.HttpServerResponse> => {
  if (client.redirectUris.includes(rawRedirectUri)) return Effect.void
  return Effect.fail(htmlBadRequestResponse(oauthErrorHtml('redirect_uri_not_allowed')))
}

const requireClientAllowsRequesterScopes = (
  client: ClientRow,
  requestedScopes: ReadonlyArray<string>
): Effect.Effect<void, HttpServerResponse.HttpServerResponse> => {
  const allowed = new Set(client.allowedScopes)
  if (requestedScopes.every((s) => allowed.has(s))) return Effect.void
  return Effect.fail(htmlBadRequestResponse(oauthErrorHtml('scope_not_allowed')))
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
      AuthorizationRequest.events.authorizationRequestStarted({
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
}): Effect.Effect<string, never, GatekeeperStore | CryptoRandom> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const cryptoRandom = yield* CryptoRandom
    const code = yield* cryptoRandom.nextUuid
    const issuedAt = yield* DateTime.now
    const expiresAt = DateTime.addDuration(issuedAt, AUTHORIZATION_CODE_TTL)
    store.commit(
      AuthorizationRequest.events.authorizationRequestApproved({
        id: input.requestId,
        grantedScopes: input.grantedScopes,
        patient: input.patient,
      }),
      AuthorizationCode.events.authorizationCodeIssued({
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

const getAuthorizationRequestParameters = (
  urlParams: AuthorizeParams
): Effect.Effect<
  {
    scopes: {
      requested: string[]
      preApproved: null | Array.NonEmptyArray<string>
      allArePreapproved: boolean
    }
    launchContext: {
      patient: null | string
    }
  },
  never,
  GatekeeperStore
> =>
  Effect.map(GatekeeperStore, (store) => {
    const requestedScopes = urlParams.scope.split(' ').filter(Boolean)

    const approvedGrant = store.query(
      Grant.queries.byClientIdAndRedirectUri$(urlParams.client_id, urlParams.redirect_uri)
    )
    const previouslyApproved = new Set<string>(approvedGrant?.scopes ?? [])
    const preApproved = requestedScopes.filter((s) => previouslyApproved.has(s))
    const allScopesPreapproved =
      approvedGrant != null && requestedScopes.every((s) => previouslyApproved.has(s))

    let preApprovedScopes: null | Array.NonEmptyArray<string> = null
    if (Array.isNonEmptyArray(preApproved)) {
      preApprovedScopes = preApproved
    }

    const patient = approvedGrant?.patient ?? null

    return {
      scopes: {
        requested: requestedScopes,
        preApproved: preApprovedScopes,
        allArePreapproved: allScopesPreapproved,
      },
      launchContext: {
        patient,
      },
    }
  })

const handleAuthorize = (
  urlParams: AuthorizeParams
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  GatekeeperStore | Origin | CryptoRandom
> =>
  pipe(
    Effect.gen(function* () {
      yield* requireSigningKey()
      const { scopes, launchContext } = yield* getAuthorizationRequestParameters(urlParams)
      yield* requireS256ChallengeMethod(urlParams.code_challenge_method)
      yield* parseRedirectUri(urlParams.redirect_uri)
      const client = yield* getEnabledClient(urlParams.client_id)
      yield* requireRedirectUriOnAllowlist(client, urlParams.redirect_uri)
      yield* requireClientAllowsRequesterScopes(client, scopes.requested)

      const cryptoRandom = yield* CryptoRandom
      const requestId = yield* cryptoRandom.nextUuid
      yield* startCodeAuthorizationRequest({
        requestId,
        clientId: urlParams.client_id,
        requestedScopes: scopes.requested,
        codeChallenge: urlParams.code_challenge,
        redirectUri: urlParams.redirect_uri,
        clientState: urlParams.state,
        preApprovedScopes: scopes.preApproved,
      })

      if (scopes.allArePreapproved) {
        const code = yield* issueCodeForAutoApprovedRequest({
          requestId,
          clientId: urlParams.client_id,
          redirectUri: urlParams.redirect_uri,
          codeChallenge: urlParams.code_challenge,
          grantedScopes: scopes.requested,
          patient: launchContext.patient,
        })
        return HttpServerResponse.redirect(
          buildClientRedirectUrl(urlParams.redirect_uri, code, urlParams.state),
          { status: 302 }
        )
      }

      const pollingUrl = yield* GatekeeperPaths.oauthPollingUrl(requestId)
      return HttpServerResponse.redirect(pollingUrl, { status: 302 })
    }),
    // Validation steps short-circuit by failing with a fully-formed
    // response; surface that response to the framework as success.
    Effect.catchAll((response: HttpServerResponse.HttpServerResponse) => Effect.succeed(response))
  )

export { handleAuthorize }
