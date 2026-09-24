/**
 * The pure half of the authorization-code flow: the URL the reader is sent to,
 * the record that has to survive the redirect, what comes back, and the token
 * exchange's request and response shapes.
 *
 * Nothing here touches the DOM, storage or the network — `sign-in.ts` supplies
 * those — so every rule the flow depends on (state must match, a token response
 * must actually carry a bearer token, the authorization parameters must be
 * scrubbed from the URL afterwards) is unit-testable.
 *
 * Every fallible step is an `Either` with a tagged error on the left, and
 * "there is no sign-in in progress" is an `Option`, not a failure — so
 * `sign-in.ts` can `yield*` all of it into one Effect and the two cases stay
 * distinguishable at the end. Everything read back from outside (storage, the
 * redirect query, the token endpoint) is decoded with a Schema before any rule
 * looks at it.
 */

import { Data, Either, Option, Schema } from 'effect'

/**
 * Raised when a returning authorization cannot be completed: the server refused
 * it, or the response does not match the request this tab made.
 */
class AuthorizationRejected extends Data.TaggedError('AuthorizationRejected')<{
  readonly reason: string
}> {}

/**
 * Raised when the token endpoint's answer is not a grant this client can use —
 * an RFC 6749 §5.2 error body, a missing token, or a token type it cannot send.
 */
class TokenExchangeFailed extends Data.TaggedError('TokenExchangeFailed')<{
  readonly reason: string
}> {}

/**
 * What the client must remember across the redirect to the authorization
 * server: the PKCE verifier it will redeem the code with, the `state` it will
 * check the return against, the target the sign-in was started for, and where
 * the app asked to land once it is signed in. The registered redirect URI
 * carries no query string, so neither `?server=` nor a return path can ride back
 * in the URL, and both travel here instead.
 *
 * This is the one thing that touches `sessionStorage`, because a full-page
 * redirect leaves no other way to carry it. It holds **no credential**: the
 * verifier is worthless without the code, and the record is deleted the moment
 * the client returns. The access token itself never goes near storage — see
 * `slices/gatekeeper/docs/Auth Token Storage Explanation.md`.
 *
 * Every field the exchange needs is a required non-empty string: a half-written
 * record cannot complete a sign-in, and treating it as one would send a request
 * with `undefined` in it.
 */
const PendingAuthorization = Schema.Struct({
  state: Schema.NonEmptyString,
  codeVerifier: Schema.NonEmptyString,
  serverUrl: Schema.NonEmptyString,
  tokenEndpoint: Schema.NonEmptyString,
  /**
   * The in-app path to land on after the sign-in, as the app handed it to
   * `beginSignIn`: raw, so the app sanitises it before navigating. Absent when
   * the app named none.
   */
  returnTo: Schema.optional(Schema.NonEmptyString),
})
type PendingAuthorization = Schema.Schema.Type<typeof PendingAuthorization>

/**
 * The pending record as the string form stored under the `sessionStorage` key
 * the app names in its `SignInEnvironment` (`sign-in.ts`).
 */
const serializePendingAuthorization = (pending: PendingAuthorization): string =>
  JSON.stringify(pending)

const decodePendingAuthorization = Schema.decodeUnknownOption(
  Schema.parseJson(PendingAuthorization)
)

/**
 * `raw` read back as a pending record, or `None` when it is absent or not one.
 * Absence is not an error here — most page loads have no record — so the caller
 * decides whether a missing one matters.
 */
const parsePendingAuthorization = (raw: string | null): Option.Option<PendingAuthorization> =>
  Option.flatMap(Option.fromNullable(raw), decodePendingAuthorization)

/**
 * An OAuth error: what the authorization server redirects back with instead of
 * a code (RFC 6749 §4.1.2.1), and what the token endpoint answers instead of a
 * token (§5.2).
 */
const OAuthError = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalWith(Schema.String, { nullable: true }),
})
type OAuthError = Schema.Schema.Type<typeof OAuthError>

const decodeOAuthError = Schema.decodeUnknownOption(OAuthError)

/** `error` with its human-readable description, when the server gave one. */
const describeOAuthError = ({ error, error_description }: OAuthError): string =>
  error_description === undefined ? error : `${error} (${error_description})`

/** Everything the authorization request carries beyond the endpoint itself. */
interface AuthorizationRequestParameters {
  readonly clientId: string
  readonly redirectUri: string
  readonly scope: string
  readonly state: string
  readonly codeChallenge: string
  /**
   * SMART's `aud`: the FHIR base the resulting token is meant for. Sent because
   * a standalone launch is specified to send it; the target's own FHIR base, so
   * it is derived from the server URL rather than configured.
   */
  readonly audience: string
}

/**
 * The URL to send the reader's browser to (RFC 6749 §4.1.1 + RFC 7636 §4.3).
 *
 * Parameters are appended to whatever the discovery document advertised, so an
 * `authorization_endpoint` that already carries a query keeps it.
 */
const authorizationRequestUrl = (
  authorizationEndpoint: string,
  parameters: AuthorizationRequestParameters
): string => {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', parameters.clientId)
  url.searchParams.set('redirect_uri', parameters.redirectUri)
  url.searchParams.set('scope', parameters.scope)
  url.searchParams.set('state', parameters.state)
  url.searchParams.set('code_challenge', parameters.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('aud', parameters.audience)
  return url.toString()
}

/** The FHIR base of `serverUrl` — the `aud` a standalone launch names. */
const fhirAudienceFor = (serverUrl: string): string => `${serverUrl}/fhir-r4`

/** A code the authorization server redirected back with (RFC 6749 §4.1.2). */
const ReturnedCode = Schema.Struct({
  code: Schema.String,
  state: Schema.optional(Schema.String),
})

const decodeReturnedCode = Schema.decodeUnknownOption(ReturnedCode)

/** A code that passed the `state` check, with the request it belongs to. */
interface RedeemableCode {
  readonly code: string
  readonly pending: PendingAuthorization
}

/**
 * Read `search` as the tail end of an authorization-code flow: `None` when this
 * is an ordinary page load, a {@link RedeemableCode} when a code came back for
 * the request this tab made, and an {@link AuthorizationRejected} when it came
 * back but cannot be completed.
 *
 * The `state` check is the CSRF gate (RFC 6749 §10.12) and it is deliberately
 * strict: a `code` with no stashed record, or with one whose `state` differs, is
 * a failure, never something to redeem anyway.
 */
const authorizationRedirectOutcome = (
  search: string,
  pending: Option.Option<PendingAuthorization>
): Either.Either<Option.Option<RedeemableCode>, AuthorizationRejected> => {
  const params = Object.fromEntries(new URLSearchParams(search))
  const refusal = decodeOAuthError(params)
  if (Option.isSome(refusal)) {
    return Either.left(
      new AuthorizationRejected({
        reason: `The server refused the sign-in: ${describeOAuthError(refusal.value)}.`,
      })
    )
  }
  const returned = decodeReturnedCode(params)
  if (Option.isNone(returned)) return Either.right(Option.none())
  if (Option.isNone(pending)) {
    return Either.left(
      new AuthorizationRejected({
        reason:
          'This page received an authorization code it did not ask for, or the ' +
          'browser dropped the request it belongs to. Sign in again.',
      })
    )
  }
  if (returned.value.state !== pending.value.state) {
    return Either.left(
      new AuthorizationRejected({
        reason: 'The sign-in came back with the wrong state parameter, so it was discarded.',
      })
    )
  }
  return Either.right(Option.some({ code: returned.value.code, pending: pending.value }))
}

/** The authorization-response parameters, which must not linger in the URL. */
const AUTHORIZATION_RESPONSE_PARAMS = ['code', 'state', 'error', 'error_description'] as const

/**
 * Whether `search` carries an authorization response — the marker of a return leg
 * from `/oauth/authorize`, whichever way it turns out.
 *
 * `main.ts` uses it to decide the two things that must happen on *every* return,
 * not just a successful one: defer mounting the reference until the sign-in
 * resolves, and scrub the response out of the address bar afterwards.
 */
const isAuthorizationResponse = (search: string): boolean => {
  const params = new URLSearchParams(search)
  return AUTHORIZATION_RESPONSE_PARAMS.some((name) => params.has(name))
}

/**
 * `search` with the authorization response stripped out, keeping everything else
 * (notably `?server=`).
 *
 * The code is single-use and already redeemed by the time this is written back,
 * but leaving it in the address bar would put it in history, in a shared link
 * and in any referrer — so the client scrubs it either way. The result includes
 * the leading `?` unless it is empty.
 */
const searchWithoutAuthorizationResponse = (search: string): string => {
  const params = new URLSearchParams(search)
  for (const name of AUTHORIZATION_RESPONSE_PARAMS) params.delete(name)
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

/**
 * The `application/x-www-form-urlencoded` body of the token request (RFC 6749
 * §4.1.3 + RFC 7636 §4.5). No client secret: this is a public client, and PKCE
 * is what binds the redemption to the browser that started the flow.
 */
const tokenRequestBody = (input: {
  readonly code: string
  readonly codeVerifier: string
  readonly redirectUri: string
  readonly clientId: string
}): string =>
  new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  }).toString()

/**
 * A successful token response (RFC 6749 §5.1) carrying a token this client can
 * send. Only a `Bearer` token is accepted, because a bearer header is the only
 * thing the client knows how to send. A refresh token is not read: the client
 * keeps no credential past the tab, so there is nothing for it to refresh into.
 */
const BearerTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.String.pipe(Schema.filter((type) => type.toLowerCase() === 'bearer')),
  scope: Schema.optionalWith(Schema.String, { nullable: true, default: () => '' }),
  expires_in: Schema.optionalWith(Schema.Finite, { nullable: true }),
})

const decodeBearerTokenResponse = Schema.decodeUnknownEither(BearerTokenResponse)

/** A usable token response, reduced to what the client keeps. */
interface AccessGrant {
  readonly accessToken: string
  /** The scopes actually granted — the Owner's narrowing, not what was asked. */
  readonly scope: string
  /** Seconds the token is good for, when the server said. */
  readonly expiresInSeconds: number | undefined
}

/**
 * A token-endpoint response read as a grant, or the reason it is not one. An
 * RFC 6749 §5.2 error body is reported with the server's own error; anything
 * else that is not a {@link BearerTokenResponse} gets one generic reason.
 */
const parseTokenResponse = (body: unknown): Either.Either<AccessGrant, TokenExchangeFailed> => {
  const refusal = decodeOAuthError(body)
  if (Option.isSome(refusal)) {
    return Either.left(
      new TokenExchangeFailed({
        reason: `The token request was rejected: ${describeOAuthError(refusal.value)}.`,
      })
    )
  }
  return decodeBearerTokenResponse(body).pipe(
    Either.map((response) => ({
      accessToken: response.access_token,
      scope: response.scope,
      expiresInSeconds: response.expires_in,
    })),
    Either.mapLeft(
      () =>
        new TokenExchangeFailed({
          reason: 'The token endpoint did not return a usable bearer token.',
        })
    )
  )
}

export {
  AuthorizationRejected,
  TokenExchangeFailed,
  serializePendingAuthorization,
  parsePendingAuthorization,
  authorizationRequestUrl,
  fhirAudienceFor,
  authorizationRedirectOutcome,
  searchWithoutAuthorizationResponse,
  isAuthorizationResponse,
  tokenRequestBody,
  parseTokenResponse,
}
export type { PendingAuthorization, AuthorizationRequestParameters, RedeemableCode, AccessGrant }
