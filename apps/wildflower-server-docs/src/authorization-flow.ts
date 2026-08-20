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
 * distinguishable at the end.
 */

import { Data, Either, Option } from 'effect'

/**
 * Raised when a returning authorization cannot be completed: the server refused
 * it, or the response does not match the request this tab made.
 */
class AuthorizationRejected extends Data.TaggedError('AuthorizationRejected')<{
  readonly reason: string
}> {}

/**
 * Raised when the token endpoint's answer is not a grant this console can use —
 * an RFC 6749 §5.2 error body, a missing token, or a token type it cannot send.
 */
class TokenExchangeFailed extends Data.TaggedError('TokenExchangeFailed')<{
  readonly reason: string
}> {}

/**
 * What the console must remember across the redirect to the authorization
 * server: the PKCE verifier it will redeem the code with, the `state` it will
 * check the return against, and the target the sign-in was started for — the
 * registered redirect URI carries no query string, so `?server=` cannot ride
 * back in the URL and travels here instead.
 *
 * This is the one thing that touches `sessionStorage`, because a full-page
 * redirect leaves no other way to carry it. It holds **no credential**: the
 * verifier is worthless without the code, and the record is deleted the moment
 * the console returns. The access token itself never goes near storage — see
 * `slices/gatekeeper/docs/Auth Token Storage Explanation.md`.
 */
interface PendingAuthorization {
  readonly state: string
  readonly codeVerifier: string
  readonly serverUrl: string
  readonly tokenEndpoint: string
}

/** The `sessionStorage` key the pending record lives at. */
const PENDING_AUTHORIZATION_KEY = 'wildflower-server-docs.pending-authorization'

/** The pending record as the string form stored under {@link PENDING_AUTHORIZATION_KEY}. */
const serializePendingAuthorization = (pending: PendingAuthorization): string =>
  JSON.stringify(pending)

/**
 * `raw` read back as a pending record, or `None` when it is absent or not one.
 *
 * Every field is required and must be a non-empty string: a half-written record
 * cannot complete a sign-in, and treating it as one would send a request with
 * `undefined` in it. Absence is not an error here — most page loads have no
 * record — so the caller decides whether a missing one matters.
 */
const parsePendingAuthorization = (raw: string | null): Option.Option<PendingAuthorization> => {
  if (raw === null) return Option.none()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return Option.none()
  }
  if (!isRecord(parsed)) return Option.none()
  return Option.all({
    state: nonEmptyString(parsed.state),
    codeVerifier: nonEmptyString(parsed.codeVerifier),
    serverUrl: nonEmptyString(parsed.serverUrl),
    tokenEndpoint: nonEmptyString(parsed.tokenEndpoint),
  })
}

/** Whether `value` is a plain JSON object (and so safe to read fields off). */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `value` when it is a non-empty string. */
const nonEmptyString = (value: unknown): Option.Option<string> =>
  typeof value === 'string' && value !== '' ? Option.some(value) : Option.none()

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
  const params = new URLSearchParams(search)
  const error = params.get('error')
  const code = params.get('code')
  if (error === null && code === null) return Either.right(Option.none())
  if (error !== null) {
    const description = params.get('error_description')
    return Either.left(
      new AuthorizationRejected({
        reason: `The server refused the sign-in: ${error}${description === null ? '' : ` (${description})`}.`,
      })
    )
  }
  if (Option.isNone(pending)) {
    return Either.left(
      new AuthorizationRejected({
        reason:
          'This page received an authorization code it did not ask for, or the ' +
          'browser dropped the request it belongs to. Sign in again.',
      })
    )
  }
  if (params.get('state') !== pending.value.state) {
    return Either.left(
      new AuthorizationRejected({
        reason: 'The sign-in came back with the wrong state parameter, so it was discarded.',
      })
    )
  }
  // `code === null` is unreachable: one of `error`/`code` is non-null to get
  // past the early return, and `error` is handled above.
  return Either.right(Option.some({ code: code ?? '', pending: pending.value }))
}

/** The authorization-response parameters, which must not linger in the URL. */
const AUTHORIZATION_RESPONSE_PARAMS = ['code', 'state', 'error', 'error_description'] as const

/**
 * `search` with the authorization response stripped out, keeping everything else
 * (notably `?server=`).
 *
 * The code is single-use and already redeemed by the time this is written back,
 * but leaving it in the address bar would put it in history, in a shared link
 * and in any referrer — so the console scrubs it either way. The result includes
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

/** A usable token response, reduced to what the console keeps. */
interface AccessGrant {
  readonly accessToken: string
  /** The scopes actually granted — the Owner's narrowing, not what was asked. */
  readonly scope: string
  /** Seconds the token is good for, when the server said. */
  readonly expiresInSeconds: number | undefined
}

/**
 * A token-endpoint response read as a grant, or the reason it is not one.
 *
 * Only a `Bearer` token is accepted, because a bearer header is the only thing
 * the console knows how to send. A refresh token in the response is **ignored**:
 * the console keeps no credential past the tab, so there is nothing for it to
 * refresh into.
 */
const parseTokenResponse = (body: unknown): Either.Either<AccessGrant, TokenExchangeFailed> => {
  if (!isRecord(body)) {
    return Either.left(
      new TokenExchangeFailed({ reason: 'The token endpoint did not answer with a JSON object.' })
    )
  }
  if (typeof body.error === 'string') {
    const description = body.error_description
    return Either.left(
      new TokenExchangeFailed({
        reason: `The token request was rejected: ${body.error}${
          typeof description === 'string' ? ` (${description})` : ''
        }.`,
      })
    )
  }
  const accessToken = body.access_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    return Either.left(
      new TokenExchangeFailed({ reason: 'The token endpoint returned no access token.' })
    )
  }
  const tokenType = body.token_type
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
    return Either.left(
      new TokenExchangeFailed({
        reason: 'The token endpoint returned a token this console cannot send.',
      })
    )
  }
  return Either.right({
    accessToken,
    scope: typeof body.scope === 'string' ? body.scope : '',
    expiresInSeconds:
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? body.expires_in
        : undefined,
  })
}

export {
  AuthorizationRejected,
  TokenExchangeFailed,
  PENDING_AUTHORIZATION_KEY,
  serializePendingAuthorization,
  parsePendingAuthorization,
  authorizationRequestUrl,
  fhirAudienceFor,
  authorizationRedirectOutcome,
  searchWithoutAuthorizationResponse,
  tokenRequestBody,
  parseTokenResponse,
}
export type { PendingAuthorization, AuthorizationRequestParameters, RedeemableCode, AccessGrant }
