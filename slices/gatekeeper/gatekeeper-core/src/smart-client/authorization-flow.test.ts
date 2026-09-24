import { Either, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  authorizationRedirectOutcome,
  authorizationRequestUrl,
  fhirAudienceFor,
  isAuthorizationResponse,
  parsePendingAuthorization,
  parseTokenResponse,
  searchWithoutAuthorizationResponse,
  serializePendingAuthorization,
  tokenRequestBody,
  type PendingAuthorization,
} from './authorization-flow.ts'

/** A pending record shaped like the one a real sign-in stashes. */
const pendingRecord: PendingAuthorization = {
  state: 'Zm9vYmFyYmF6cXV4',
  codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  serverUrl: 'https://ruth.wildflowerhealth.io',
  tokenEndpoint: 'https://ruth.wildflowerhealth.io/oauth/token',
  returnTo: '/settings/tunnel',
}

/** Arbitrary pending records, for the round-trip properties. */
const pendingArbitrary = fc.record({
  state: fc.string({ minLength: 1 }),
  codeVerifier: fc.string({ minLength: 1 }),
  serverUrl: fc.webUrl(),
  tokenEndpoint: fc.webUrl(),
  returnTo: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
})

describe('serializePendingAuthorization / parsePendingAuthorization', () => {
  it('round-trips a pending record through the string form storage holds', () => {
    fc.assert(
      fc.property(pendingArbitrary, (pending) => {
        // Act
        const parsed = parsePendingAuthorization(serializePendingAuthorization(pending))

        // Assert
        expect(parsed).toEqual(Option.some(pending))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reads an absent record as None, which is not a failure', () => {
    // Act / Assert
    expect(parsePendingAuthorization(null)).toEqual(Option.none())
  })

  it('refuses a record missing any field the exchange needs', () => {
    fc.assert(
      fc.property(
        pendingArbitrary,
        fc.constantFrom('state', 'codeVerifier', 'serverUrl', 'tokenEndpoint'),
        (pending, dropped) => {
          // Arrange
          const partial: Record<string, unknown> = { ...pending }
          delete partial[dropped]

          // Act / Assert
          expect(parsePendingAuthorization(JSON.stringify(partial))).toEqual(Option.none())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('refuses a record whose returnTo is present but not a non-empty string', () => {
    fc.assert(
      fc.property(
        pendingArbitrary,
        fc.oneof(
          fc.constant(''),
          fc.constant(null),
          fc.integer(),
          fc.boolean(),
          fc.array(fc.string())
        ),
        (pending, returnTo) => {
          // Arrange
          const raw = JSON.stringify({ ...pending, returnTo })

          // Act / Assert
          expect(parsePendingAuthorization(raw)).toEqual(Option.none())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('refuses stored junk instead of half-reading it', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.jsonValue().map((v) => JSON.stringify(v))
        ),
        (raw) => {
          // Act
          const parsed = parsePendingAuthorization(raw)

          // Assert — only a complete record parses, and this arbitrary makes none.
          if (Option.isSome(parsed)) {
            expect(Object.keys(parsed.value).toSorted()).toEqual([
              'codeVerifier',
              'returnTo',
              'serverUrl',
              'state',
              'tokenEndpoint',
            ])
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('authorizationRequestUrl', () => {
  it('builds a PKCE authorization-code request the gatekeeper endpoint accepts', () => {
    // Act
    const url = new URL(
      authorizationRequestUrl('https://ruth.wildflowerhealth.io/oauth/authorize', {
        clientId: 'wildflower-server-docs',
        redirectUri: 'https://wildflowerhealth.io/wildflower-server-docs/',
        scope: 'openid system/*.cruds',
        state: 'state-value',
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        audience: 'https://ruth.wildflowerhealth.io/fhir-r4',
      })
    )

    // Assert
    expect(url.origin + url.pathname).toBe('https://ruth.wildflowerhealth.io/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'wildflower-server-docs',
      redirect_uri: 'https://wildflowerhealth.io/wildflower-server-docs/',
      scope: 'openid system/*.cruds',
      state: 'state-value',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      aud: 'https://ruth.wildflowerhealth.io/fhir-r4',
    })
  })

  it('keeps a query the discovery document already put on the endpoint', () => {
    // Act
    const url = new URL(
      authorizationRequestUrl('https://example.test/authorize?tenant=acme', {
        clientId: 'wildflower-server-docs',
        redirectUri: 'https://wildflowerhealth.io/wildflower-server-docs/',
        scope: 'openid',
        state: 's',
        codeChallenge: 'c',
        audience: 'https://example.test/fhir-r4',
      })
    )

    // Assert
    expect(url.searchParams.get('tenant')).toBe('acme')
    expect(url.searchParams.get('response_type')).toBe('code')
  })
})

describe('fhirAudienceFor', () => {
  it('names the target’s FHIR base, which is what a standalone launch audits against', () => {
    // Act / Assert
    expect(fhirAudienceFor('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/fhir-r4')
  })
})

describe('authorizationRedirectOutcome', () => {
  it('reads an ordinary page load as no sign-in in progress', () => {
    fc.assert(
      fc.property(fc.webUrl(), (serverUrl) => {
        // Act
        const outcome = authorizationRedirectOutcome(
          `?server=${encodeURIComponent(serverUrl)}`,
          Option.some(pendingRecord)
        )

        // Assert
        expect(outcome).toEqual(Either.right(Option.none()))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('accepts a code whose state matches the stashed record', () => {
    // Act
    const outcome = authorizationRedirectOutcome(
      `?code=abc123&state=${pendingRecord.state}`,
      Option.some(pendingRecord)
    )

    // Assert
    expect(outcome).toEqual(Either.right(Option.some({ code: 'abc123', pending: pendingRecord })))
  })

  it('never redeems a code whose state differs from the stashed one', () => {
    fc.assert(
      fc.property(
        fc.string().filter((state) => state !== pendingRecord.state),
        (state) => {
          // Act
          const outcome = authorizationRedirectOutcome(
            `?code=abc123&state=${encodeURIComponent(state)}`,
            Option.some(pendingRecord)
          )

          // Assert
          expect(Either.isLeft(outcome)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('never redeems a code that arrives with no stashed record at all', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (code, state) => {
        // Act
        const outcome = authorizationRedirectOutcome(
          `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          Option.none()
        )

        // Assert
        expect(Either.isLeft(outcome)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('surfaces the server’s own refusal, description included', () => {
    // Act
    const outcome = authorizationRedirectOutcome(
      '?error=access_denied&error_description=Owner%20declined&state=x',
      Option.some(pendingRecord)
    )

    // Assert
    if (Either.isRight(outcome)) throw new Error('expected the refusal to be surfaced')
    expect(outcome.left._tag).toBe('AuthorizationRejected')
    expect(outcome.left.reason).toContain('access_denied')
    expect(outcome.left.reason).toContain('Owner declined')
  })
})

describe('searchWithoutAuthorizationResponse', () => {
  it('drops the authorization response and keeps the chosen server', () => {
    // Act
    const search = searchWithoutAuthorizationResponse(
      '?server=https%3A%2F%2Fruth.wildflowerhealth.io&code=abc&state=xyz'
    )

    // Assert
    expect(search).toBe('?server=https%3A%2F%2Fruth.wildflowerhealth.io')
  })

  it('never leaves a code or state behind, whatever else the query holds', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
        fc.string({ minLength: 1 }),
        (extras, code) => {
          // Arrange
          const params = new URLSearchParams(extras)
          params.set('code', code)
          params.set('state', 'whatever')

          // Act
          const search = searchWithoutAuthorizationResponse(`?${params.toString()}`)

          // Assert
          const remaining = new URLSearchParams(search)
          expect(remaining.get('code')).toBeNull()
          expect(remaining.get('state')).toBeNull()
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reduces an emptied query to the empty string, not a bare ?', () => {
    // Act / Assert
    expect(searchWithoutAuthorizationResponse('?code=abc&state=xyz')).toBe('')
  })
})

describe('isAuthorizationResponse', () => {
  it('recognises each response parameter as a return leg', () => {
    // Act / Assert — a code, or a bare state, or an error is all a return leg.
    expect(isAuthorizationResponse('?code=abc&state=xyz')).toBe(true)
    expect(isAuthorizationResponse('?state=xyz')).toBe(true)
    expect(isAuthorizationResponse('?error=access_denied')).toBe(true)
  })

  it('does not mistake an ordinary configured load for a return leg', () => {
    // Act / Assert — `?server=` alone, or nothing, is not a return.
    expect(isAuthorizationResponse('?server=https%3A%2F%2Fruth.wildflowerhealth.io')).toBe(false)
    expect(isAuthorizationResponse('')).toBe(false)
  })

  it('is true as soon as any one response parameter is present', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
        fc.constantFrom('code', 'state', 'error', 'error_description'),
        fc.string(),
        (extras, name, value) => {
          // Arrange
          const params = new URLSearchParams(extras)
          params.set(name, value)

          // Act / Assert
          expect(isAuthorizationResponse(`?${params.toString()}`)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('is false for a query carrying no response parameter', () => {
    const RESPONSE_NAMES = new Set(['code', 'state', 'error', 'error_description'])
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1 }).filter((key) => !RESPONSE_NAMES.has(key)),
          fc.string()
        ),
        (extras) => {
          // Act / Assert
          expect(isAuthorizationResponse(`?${new URLSearchParams(extras).toString()}`)).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('tokenRequestBody', () => {
  it('redeems the code with the verifier and no client secret', () => {
    // Act
    const body = new URLSearchParams(
      tokenRequestBody({
        code: 'the-code',
        codeVerifier: 'the-verifier',
        redirectUri: 'https://wildflowerhealth.io/wildflower-server-docs/',
        clientId: 'wildflower-server-docs',
      })
    )

    // Assert
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://wildflowerhealth.io/wildflower-server-docs/',
      client_id: 'wildflower-server-docs',
      code_verifier: 'the-verifier',
    })
  })
})

describe('parseTokenResponse', () => {
  it('reads a gatekeeper token response as a grant', () => {
    // Act
    const result = parseTokenResponse({
      access_token: 'header.payload.signature',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid system/*.cruds',
    })

    // Assert
    expect(result).toEqual(
      Either.right({
        accessToken: 'header.payload.signature',
        scope: 'openid system/*.cruds',
        expiresInSeconds: 3600,
      })
    )
  })

  it('keeps no refresh token, because nothing outlives the tab to use one', () => {
    // Act
    const result = parseTokenResponse({
      access_token: 'a-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'offline_access',
      refresh_token: 'the-refresh-token',
    })

    // Assert
    if (Either.isLeft(result)) throw new Error(result.left.reason)
    expect(JSON.stringify(result.right)).not.toContain('the-refresh-token')
  })

  it('surfaces an RFC 6749 §5.2 error body', () => {
    // Act
    const result = parseTokenResponse({
      error: 'invalid_grant',
      error_description: 'Invalid authorization grant',
    })

    // Assert
    if (Either.isRight(result)) throw new Error('expected the error body to be refused')
    expect(result.left._tag).toBe('TokenExchangeFailed')
    expect(result.left.reason).toContain('invalid_grant')
  })

  it('refuses a response with no access token', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<unknown>(
          {},
          { token_type: 'Bearer' },
          { access_token: '', token_type: 'Bearer' },
          { access_token: 42, token_type: 'Bearer' },
          'a string',
          null,
          []
        ),
        (body) => {
          // Act / Assert
          expect(Either.isLeft(parseTokenResponse(body))).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('never accepts a token the client could not send as a bearer', () => {
    fc.assert(
      fc.property(
        fc.string().filter((type) => type.toLowerCase() !== 'bearer'),
        (tokenType) => {
          // Act
          const result = parseTokenResponse({ access_token: 'a-token', token_type: tokenType })

          // Assert
          expect(Either.isLeft(result)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
