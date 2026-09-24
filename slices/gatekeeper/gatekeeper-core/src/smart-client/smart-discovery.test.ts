import { Effect, Either, Match } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  discoverSmartEndpoints,
  insecureTargetReason,
  SMART_CONFIGURATION_PATH,
  smartConfigurationUrl,
  smartEndpointsFrom,
  usableEndpointUrl,
} from './smart-discovery.ts'

/**
 * A discovery document shaped like the one `emr-rust`'s
 * `build_smart_configuration` serves, trimmed to the fields this client reads.
 */
const wildflowerDiscoveryDocument = (origin: string): Record<string, unknown> => ({
  issuer: 'https://wildflowerhealth.io',
  jwks_uri: `${origin}/.well-known/jwks.json`,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  grant_types_supported: ['authorization_code', 'client_credentials'],
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
})

const onSecurePage = { pageIsSecure: true }

describe('smartConfigurationUrl', () => {
  it('appends the SMART well-known path to the canonical target', () => {
    // Act / Assert
    expect(smartConfigurationUrl('https://ruth.wildflowerhealth.io')).toBe(
      'https://ruth.wildflowerhealth.io/fhir-r4/.well-known/smart-configuration'
    )
    expect(smartConfigurationUrl('http://127.0.0.1:8080')).toBe(
      `http://127.0.0.1:8080${SMART_CONFIGURATION_PATH}`
    )
  })
})

describe('usableEndpointUrl', () => {
  it('accepts an absolute https endpoint', () => {
    // Act / Assert
    expect(usableEndpointUrl('https://example.test/oauth/authorize', onSecurePage)).toBe(
      'https://example.test/oauth/authorize'
    )
  })

  it('accepts a loopback http endpoint even from the published https page', () => {
    // A desktop host serves its API on loopback, which browsers treat as
    // potentially trustworthy — the same exception the client's own requests
    // rely on.
    expect(usableEndpointUrl('http://127.0.0.1:8080/oauth/token', onSecurePage)).toBe(
      'http://127.0.0.1:8080/oauth/token'
    )
    expect(usableEndpointUrl('http://localhost:8080/oauth/token', onSecurePage)).toBe(
      'http://localhost:8080/oauth/token'
    )
  })

  it('rejects a plain-http endpoint on a remote host while the page is secure', () => {
    fc.assert(
      fc.property(fc.domain(), (host) => {
        // Act
        const result = usableEndpointUrl(`http://${host}/oauth/token`, onSecurePage)

        // Assert
        expect(result).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('accepts the same plain-http endpoint when the client itself is not secure', () => {
    // Act / Assert
    expect(usableEndpointUrl('http://server.test/oauth/token', { pageIsSecure: false })).toBe(
      'http://server.test/oauth/token'
    )
  })

  it('rejects anything that is not an absolute http(s) URL', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'javascript:alert(1)',
          'data:text/html,x',
          '//example.test/oauth/token',
          '/oauth/token',
          'example.test/oauth/token',
          'ftp://example.test/token',
          'wss://example.test/token',
          '',
          '   '
        ),
        (candidate) => {
          // Act / Assert
          expect(usableEndpointUrl(candidate, onSecurePage)).toBeUndefined()
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('rejects an endpoint carrying credentials or a fragment', () => {
    // Credentials would ride into the address bar on redirect; a fragment would
    // strand the query parameters the authorize URL appends.
    expect(
      usableEndpointUrl('https://user:pw@example.test/authorize', onSecurePage)
    ).toBeUndefined()
    expect(usableEndpointUrl('https://example.test/authorize#here', onSecurePage)).toBeUndefined()
  })
})

describe('smartEndpointsFrom', () => {
  it('reads both endpoints out of a Wildflower discovery document', () => {
    // Arrange
    const document = wildflowerDiscoveryDocument('https://ruth.wildflowerhealth.io')

    // Act
    const result = smartEndpointsFrom(document, onSecurePage)

    // Assert
    expect(result).toEqual(
      Either.right({
        authorizationEndpoint: 'https://ruth.wildflowerhealth.io/oauth/authorize',
        tokenEndpoint: 'https://ruth.wildflowerhealth.io/oauth/token',
      })
    )
  })

  it('reports a document that advertises no usable endpoints', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Record<string, unknown>>(
          {},
          { authorization_endpoint: 'https://example.test/authorize' },
          { token_endpoint: 'https://example.test/token' },
          { authorization_endpoint: 'not a url', token_endpoint: 'https://example.test/token' }
        ),
        (document) => {
          // Act
          const result = smartEndpointsFrom(document, onSecurePage)

          // Assert
          expect(Either.isLeft(result)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('reports a document whose endpoints are not strings', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string())),
        fc.constantFrom('authorization_endpoint', 'token_endpoint'),
        (endpoint, field) => {
          // Arrange
          const document = {
            ...wildflowerDiscoveryDocument('https://example.test'),
            [field]: endpoint,
          }

          // Act
          const result = smartEndpointsFrom(document, onSecurePage)

          // Assert
          expect(Either.isLeft(result)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('reports a body that is not a JSON object at all', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.array(fc.jsonValue())),
        (document) => {
          // Act
          const result = smartEndpointsFrom(document, onSecurePage)

          // Assert
          expect(Either.isLeft(result)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('refuses a server that advertises PKCE without S256', () => {
    // Arrange
    const document = {
      ...wildflowerDiscoveryDocument('https://example.test'),
      code_challenge_methods_supported: ['plain'],
    }

    // Act
    const result = smartEndpointsFrom(document, onSecurePage)

    // Assert
    if (Either.isRight(result)) throw new Error('expected a plain-only server to be refused')
    expect(result.left._tag).toBe('DiscoveryFailed')
    expect(result.left.reason).toContain('S256')
  })

  it('accepts a document that says nothing about PKCE methods', () => {
    // Arrange
    const { code_challenge_methods_supported: _omitted, ...document } =
      wildflowerDiscoveryDocument('https://example.test')

    // Act
    const result = smartEndpointsFrom(document, onSecurePage)

    // Assert
    expect(Either.isRight(result)).toBe(true)
  })
})

describe('discoverSmartEndpoints', () => {
  it('fetches the well-known document from the chosen server', async () => {
    // Arrange
    const requested: string[] = []
    const fetchStub = respondingWith((url) => {
      requested.push(url)
      return jsonResponse(wildflowerDiscoveryDocument('https://ruth.wildflowerhealth.io'))
    })

    // Act
    const result = await runToEither(
      discoverSmartEndpoints('https://ruth.wildflowerhealth.io', {
        fetch: fetchStub,
        pageIsSecure: true,
      })
    )

    // Assert
    expect(requested).toEqual([
      'https://ruth.wildflowerhealth.io/fhir-r4/.well-known/smart-configuration',
    ])
    expect(Either.isRight(result)).toBe(true)
  })

  it('reports an unreachable server rather than throwing', async () => {
    // Arrange
    const fetchStub = respondingWith(() => {
      throw new TypeError('Failed to fetch')
    })

    // Act
    const result = await runToEither(
      discoverSmartEndpoints('https://down.test', { fetch: fetchStub, pageIsSecure: true })
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected an unreachable server to be reported')
    expect(result.left._tag).toBe('DiscoveryFailed')
    expect(result.left.reason).toContain('https://down.test')
  })

  it('reports a target that answers with an error status', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 400, max: 599 }), async (status) => {
        // Arrange
        const fetchStub = respondingWith(() => new Response('nope', { status }))

        // Act
        const result = await runToEither(
          discoverSmartEndpoints('https://not-wildflower.test', {
            fetch: fetchStub,
            pageIsSecure: true,
          })
        )

        // Assert
        if (Either.isRight(result)) throw new Error('expected an error status to be reported')
        expect(result.left.reason).toContain(String(status))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('reports a target that answers with something other than JSON', async () => {
    // Arrange
    const fetchStub = respondingWith(() => new Response('<html>hello</html>', { status: 200 }))

    // Act
    const result = await runToEither(
      discoverSmartEndpoints('https://marketing-site.test', {
        fetch: fetchStub,
        pageIsSecure: true,
      })
    )

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe('insecureTargetReason', () => {
  it('explains why a secure page cannot reach a plaintext server', () => {
    // Arrange / Act
    const reason = insecureTargetReason('http://fhir.example', onSecurePage)

    // Assert
    expect(reason).toContain('http://fhir.example')
    expect(reason).toContain('https')
  })

  it('says nothing about a loopback target, which browsers do allow', () => {
    // A desktop host's API on loopback is the published console's normal case,
    // not a downgrade — see `usableEndpointUrl`'s matching exception.
    expect(insecureTargetReason('http://127.0.0.1:8080', onSecurePage)).toBeUndefined()
    expect(insecureTargetReason('http://localhost:8080', onSecurePage)).toBeUndefined()
  })

  it('says nothing when the page itself is not secure', () => {
    // A dev server on http may talk to a plaintext server freely.
    expect(insecureTargetReason('http://fhir.example', { pageIsSecure: false })).toBeUndefined()
  })

  it('never objects to an https target', () => {
    fc.assert(
      fc.property(fc.domain(), fc.webPath(), (domain, path) => {
        // Act
        const reason = insecureTargetReason(`https://${domain}${path}`, onSecurePage)

        // Assert
        expect(reason).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('always objects to exactly what discovery would go on to reject', () => {
    // The point of this function is to say early what `usableEndpointUrl` says
    // late, so the two must never disagree about the same target.
    fc.assert(
      fc.property(fc.domain(), fc.webPath(), (domain, path) => {
        // Arrange
        const target = `http://${domain}${path}`

        // Act
        const reason = insecureTargetReason(target, onSecurePage)

        // Assert
        expect(reason).toBeDefined()
        expect(usableEndpointUrl(target, onSecurePage)).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** Run a discovery Effect to its `Either`, so both channels are assertable. */
const runToEither = <A, E>(effect: Effect.Effect<A, E>): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.either(effect))

/** The URL a `fetch` argument names, in any of the three forms it can take. */
const requestUrl = Match.type<Parameters<typeof globalThis.fetch>[0]>().pipe(
  Match.withReturnType<string>(),
  Match.when(Match.string, (s) => s),
  Match.when({ href: Match.string }, (u) => u.href),
  Match.when({ url: Match.string }, (r) => r.url),
  Match.exhaustive
)

/** A `fetch` stub built from a per-URL responder. */
const respondingWith =
  (respond: (url: string) => Response): typeof globalThis.fetch =>
  (input) =>
    Promise.resolve(respond(requestUrl(input)))

/** A 200 JSON response carrying `body`. */
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
