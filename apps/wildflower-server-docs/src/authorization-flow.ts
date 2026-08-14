/**
 * The pure half of the authorization-code flow: the URL the reader is sent to,
 * the record that has to survive the redirect, what comes back, and the token
 * exchange's request and response shapes.
 *
 * Nothing here touches the DOM, storage or the network — `sign-in.ts` supplies
 * those — so every rule the flow depends on (state must match, a token response
 * must actually carry a bearer token, the authorization parameters must be
 * scrubbed from the URL afterwards) is unit-testable.
 */

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
export interface PendingAuthorization {
  readonly state: string
  readonly codeVerifier: string
  readonly serverUrl: string
  readonly tokenEndpoint: string
}

/** The `sessionStorage` key the pending record lives at. */
export const PENDING_AUTHORIZATION_KEY = 'wildflower-server-docs.pending-authorization'

/** The pending record as the string form stored under {@link PENDING_AUTHORIZATION_KEY}. */
export const serializePendingAuthorization = (pending: PendingAuthorization): string =>
  JSON.stringify(pending)

/**
 * `raw` read back as a pending record, or `undefined` when it is absent or not
 * one. Every field is required and must be a non-empty string: a half-written
 * record cannot complete a sign-in, and treating it as one would send a request
 * with `undefined` in it.
 */
export const parsePendingAuthorization = (raw: string | null): PendingAuthorization | undefined => {
  if (raw === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const state = nonEmptyString(parsed.state)
  const codeVerifier = nonEmptyString(parsed.codeVerifier)
  const serverUrl = nonEmptyString(parsed.serverUrl)
  const tokenEndpoint = nonEmptyString(parsed.tokenEndpoint)
  if (
    state === undefined ||
    codeVerifier === undefined ||
    serverUrl === undefined ||
    tokenEndpoint === undefined
  ) {
    return undefined
  }
  return { state, codeVerifier, serverUrl, tokenEndpoint }
}

/** Whether `value` is a plain JSON object (and so safe to read fields off). */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `value` when it is a non-empty string, else `undefined`. */
const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** Everything the authorization request carries beyond the endpoint itself. */
export interface AuthorizationRequestParameters {
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
export const authorizationRequestUrl = (
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
export const fhirAudienceFor = (serverUrl: string): string => `${serverUrl}/fhir-r4`

/** What a page load's query string means for a sign-in in progress. */
export type RedirectOutcome =
  /** Not a return from the authorization server; an ordinary page load. */
  | { readonly kind: 'none' }
  /** A code to redeem, already checked against the stashed `state`. */
  | { readonly kind: 'code'; readonly code: string; readonly pending: PendingAuthorization }
  /** The flow came back, but cannot be completed. */
  | { readonly kind: 'failed'; readonly problem: string }

/**
 * Read `search` as the tail end of an authorization-code flow.
 *
 * The `state` check is the CSRF gate (RFC 6749 §10.12) and it is deliberately
 * strict: a `code` with no stashed record, or with one whose `state` differs, is
 * a failure, never something to redeem anyway.
 */
export const authorizationRedirectOutcome = (
  search: string,
  pending: PendingAuthorization | undefined
): RedirectOutcome => {
  const params = new URLSearchParams(search)
  const error = params.get('error')
  const code = params.get('code')
  if (error === null && code === null) return { kind: 'none' }
  const state = params.get('state')
  if (error !== null) {
    const description = params.get('error_description')
    return {
      kind: 'failed',
      problem: `The server refused the sign-in: ${error}${description === null ? '' : ` (${description})`}.`,
    }
  }
  if (pending === undefined) {
    return {
      kind: 'failed',
      problem:
        'This page received an authorization code it did not ask for, or the ' +
        'browser dropped the request it belongs to. Sign in again.',
    }
  }
  if (state !== pending.state) {
    return {
      kind: 'failed',
      problem: 'The sign-in came back with the wrong state parameter, so it was discarded.',
    }
  }
  // `code === null` is unreachable: one of `error`/`code` is non-null to get
  // past the early return, and `error` is handled above.
  return { kind: 'code', code: code ?? '', pending }
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
export const searchWithoutAuthorizationResponse = (search: string): string => {
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
export const tokenRequestBody = (input: {
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
export interface AccessGrant {
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
export const parseTokenResponse = (
  body: unknown
):
  | { readonly ok: true; readonly grant: AccessGrant }
  | { readonly ok: false; readonly problem: string } => {
  if (!isRecord(body)) {
    return { ok: false, problem: 'The token endpoint did not answer with a JSON object.' }
  }
  const record = body
  if (typeof record.error === 'string') {
    const description = record.error_description
    return {
      ok: false,
      problem: `The token request was rejected: ${record.error}${
        typeof description === 'string' ? ` (${description})` : ''
      }.`,
    }
  }
  const accessToken = record.access_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, problem: 'The token endpoint returned no access token.' }
  }
  const tokenType = record.token_type
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
    return { ok: false, problem: 'The token endpoint returned a token this console cannot send.' }
  }
  return {
    ok: true,
    grant: {
      accessToken,
      scope: typeof record.scope === 'string' ? record.scope : '',
      expiresInSeconds:
        typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)
          ? record.expires_in
          : undefined,
    },
  }
}
