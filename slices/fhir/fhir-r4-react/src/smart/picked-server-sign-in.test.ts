import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  insecureTargetReason as sharedInsecureTargetReason,
  normalizeServerUrl as sharedNormalizeServerUrl,
  PendingRequestUnusable,
  type SmartIssuer,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect, Match } from 'effect'

import {
  detectSmartSupport,
  insecureTargetReason,
  normalizeServerUrl,
  redirectToPickedServerSignIn,
  SmartSupport,
} from './picked-server-sign-in.ts'
import type { SelfAddressedSignInConfig, SmartLaunchConfig } from './sign-in-redirect.ts'
import { decodeFhirBaseUrl } from './smart-connection.ts'

// `redirectToPickedServerSignIn` hands the sign-in to `sign-in-redirect.ts`,
// whose own suite covers the sign-in and the navigation, so the module
// boundary is where we stub. `detectSmartSupport`'s tests never touch it (they
// inject `fetchFn`).
const { redirectToSignInAtMock, redirectToSelfAddressedSignInReturnMock } = vi.hoisted(() => ({
  redirectToSignInAtMock:
    vi.fn<
      (
        discovered: SmartIssuer,
        config: Omit<SmartLaunchConfig, 'fhirBaseUrl'>
      ) => Effect.Effect<void, PendingRequestUnusable>
    >(),
  redirectToSelfAddressedSignInReturnMock:
    vi.fn<(config: SelfAddressedSignInConfig) => Effect.Effect<void>>(),
}))

vi.mock('./sign-in-redirect.ts', () => ({
  redirectToSignInAt: redirectToSignInAtMock,
  redirectToSelfAddressedSignInReturn: redirectToSelfAddressedSignInReturnMock,
}))

beforeEach(() => {
  vi.clearAllMocks()
  redirectToSignInAtMock.mockReturnValue(Effect.void)
  redirectToSelfAddressedSignInReturnMock.mockReturnValue(Effect.void)
  vi.stubGlobal('location', { protocol: 'https:' })
})

/** The support `fhirBaseUrl` gives, probed through `fetchFn`. */
const supportOf = (
  fhirBaseUrl: string,
  fetchFn: typeof fetch,
  pageIsSecure?: boolean
): Promise<SmartSupport> =>
  Effect.runPromise(detectSmartSupport(decodeFhirBaseUrl(fhirBaseUrl), fetchFn, pageIsSecure))

afterEach(() => {
  vi.unstubAllGlobals()
})

// Helpers

/** The URL string of a `fetch` first argument, in each of its three shapes. */
const urlOf = Match.type<RequestInfo | URL>().pipe(
  Match.withReturnType<string>(),
  Match.when({ href: Match.string }, (url) => url.href),
  Match.when({ url: Match.string }, (req) => req.url),
  Match.when(Match.string, (str) => str),
  Match.exhaustive
)

/** A `fetch` stub that records each URL it was called with and answers `body`. */
const fetchReturning = (body: Response, seenUrls: string[] = []): typeof fetch =>
  vi.fn<typeof fetch>((input) => {
    seenUrls.push(urlOf(input))
    return Promise.resolve(body)
  })

/** A `fetch` stub that rejects — the network/CORS-failure shape. */
const fetchRejecting = (error: unknown): typeof fetch =>
  vi.fn<typeof fetch>(() => Promise.reject(error))

/**
 * A SMART configuration whose endpoints are usable from an https page, shaped
 * like the SmartHealthIT sandbox's: https endpoints, and S256.
 */
const SMART_CONFIGURATION = {
  authorization_endpoint: 'https://ehr.example/authorize',
  token_endpoint: 'https://ehr.example/token',
  code_challenge_methods_supported: ['S256'],
}

/** The issuer {@link SMART_CONFIGURATION} describes, served at `fhirBaseUrl`. */
const smartIssuerAt = (fhirBaseUrl: string): Partial<SmartIssuer> => ({
  smartServer: { _tag: 'PlainSmartServer', fhirBaseUrl },
  endpoints: {
    authorizationEndpoint: SMART_CONFIGURATION.authorization_endpoint,
    tokenEndpoint: SMART_CONFIGURATION.token_endpoint,
  },
})

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

describe('detectSmartSupport', () => {
  it('is `Smart`, carrying the issuer it read, when the config names usable endpoints', async () => {
    const support = await supportOf(
      'https://ehr.example/fhir',
      fetchReturning(jsonResponse(SMART_CONFIGURATION))
    )
    expect(support).toMatchObject({
      _tag: 'Smart',
      discovered: smartIssuerAt('https://ehr.example/fhir'),
    })
  })

  it.each([
    {
      case: 'a javascript: authorization_endpoint',
      configuration: { ...SMART_CONFIGURATION, authorization_endpoint: 'javascript:alert(1)' },
    },
    {
      case: 'an authorization_endpoint with userinfo',
      configuration: {
        ...SMART_CONFIGURATION,
        authorization_endpoint: 'https://user:pw@ehr.example/authorize',
      },
    },
    {
      case: 'a plain-http token_endpoint off loopback',
      configuration: { ...SMART_CONFIGURATION, token_endpoint: 'http://ehr.example/token' },
    },
  ])('is `Unusable`, with the discovery reason, for $case', async ({ configuration }) => {
    const support = await supportOf(
      'https://ehr.example/fhir',
      fetchReturning(jsonResponse(configuration)),
      true
    )
    expect(support).toEqual({
      _tag: 'Unusable',
      reason:
        'The server’s SMART configuration does not advertise a usable ' +
        'authorization_endpoint and token_endpoint over https (or loopback).',
    })
  })

  it('is `Unusable` when the config names an authorization_endpoint but no token_endpoint', async () => {
    const support = await supportOf(
      'https://ehr.example/fhir',
      fetchReturning(jsonResponse({ authorization_endpoint: 'https://ehr.example/authorize' })),
      true
    )
    expect(support).toMatchObject({ _tag: 'Unusable' })
  })

  it('is `Smart` for a plain-http endpoint when the page is itself http', async () => {
    const support = await supportOf(
      'http://ehr.example/fhir',
      fetchReturning(
        jsonResponse({
          ...SMART_CONFIGURATION,
          authorization_endpoint: 'http://ehr.example/authorize',
          token_endpoint: 'http://ehr.example/token',
        })
      ),
      false
    )
    expect(support).toMatchObject({ _tag: 'Smart' })
  })

  it('reads whether the page is secure off the page by default', async () => {
    // The https page stubbed above: a plain-http endpoint off loopback is unusable
    const support = await supportOf(
      'https://ehr.example/fhir',
      fetchReturning(
        jsonResponse({ ...SMART_CONFIGURATION, authorization_endpoint: 'http://ehr.example/a' })
      )
    )
    expect(support).toMatchObject({ _tag: 'Unusable' })
  })

  it('probes the well-known path under the decoded FHIR base, its trailing slash trimmed', async () => {
    const seenUrls: string[] = []
    await supportOf(
      'https://ehr.example/fhir/',
      fetchReturning(jsonResponse(SMART_CONFIGURATION), seenUrls)
    )
    expect(seenUrls).toEqual(['https://ehr.example/fhir/.well-known/smart-configuration'])
  })

  it('is `Open` on a non-ok HTTP answer (the server has no SMART config)', async () => {
    const support = await supportOf(
      'https://open.example/fhir',
      fetchReturning(new Response(null, { status: 404 }))
    )
    expect(support).toEqual(SmartSupport.Open())
  })

  it('is `Open` when the config carries no authorization_endpoint', async () => {
    const support = await supportOf(
      'https://open.example/fhir',
      fetchReturning(jsonResponse({ token_endpoint: 'https://open.example/token' }))
    )
    expect(support).toEqual(SmartSupport.Open())
  })

  it('is `Open` when the ok response is not JSON', async () => {
    const support = await supportOf(
      'https://open.example/fhir',
      fetchReturning(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }))
    )
    expect(support).toEqual(SmartSupport.Open())
  })

  it('is `Unreachable` (not `Open`) when the probe rejects — a CORS/down server is not open access', async () => {
    const support = await supportOf(
      'https://blocked.example/fhir',
      fetchRejecting(new TypeError('Failed to fetch'))
    )
    expect(support).toEqual(SmartSupport.Unreachable({ reason: 'Failed to fetch' }))
  })
})

describe('redirectToPickedServerSignIn', () => {
  const config = {
    fhirBaseUrl: decodeFhirBaseUrl('https://ehr.example/fhir'),
    clientId: '9769f8b274370708d0d3ebb2e3e59b7c',
    scope: 'launch openid fhirUser',
    redirectUri: 'https://app.example/',
  }

  it('signs in at what the probe discovered, fetching its configuration once, when the probe is `Smart`', async () => {
    const seenUrls: string[] = []
    const support = await Effect.runPromise(
      redirectToPickedServerSignIn(
        config,
        fetchReturning(jsonResponse(SMART_CONFIGURATION), seenUrls)
      )
    )
    expect(seenUrls).toEqual(['https://ehr.example/fhir/.well-known/smart-configuration'])
    expect(support).toMatchObject({ _tag: 'Smart', discovered: smartIssuerAt(config.fhirBaseUrl) })
    expect(redirectToSignInAtMock).toHaveBeenCalledExactlyOnceWith(
      SmartSupport.$is('Smart')(support) ? support.discovered : undefined,
      config
    )
    expect(redirectToSelfAddressedSignInReturnMock).not.toHaveBeenCalled()
  })

  it('signs in by a self-addressed redirect when the probe is `Open`', async () => {
    const support = await Effect.runPromise(
      redirectToPickedServerSignIn(config, fetchReturning(new Response(null, { status: 404 })))
    )
    expect(redirectToSelfAddressedSignInReturnMock).toHaveBeenCalledExactlyOnceWith({
      fhirBaseUrl: 'https://ehr.example/fhir',
      redirectUri: 'https://app.example/',
    })
    expect(redirectToSignInAtMock).not.toHaveBeenCalled()
    expect(support).toEqual(SmartSupport.Open())
  })

  it('does not redirect at all when the probe is `Unusable`, returning it for the UI', async () => {
    const support = await Effect.runPromise(
      redirectToPickedServerSignIn(
        config,
        fetchReturning(
          jsonResponse({ ...SMART_CONFIGURATION, authorization_endpoint: 'javascript:alert(1)' })
        )
      )
    )
    expect(redirectToSignInAtMock).not.toHaveBeenCalled()
    expect(redirectToSelfAddressedSignInReturnMock).not.toHaveBeenCalled()
    expect(support).toMatchObject({ _tag: 'Unusable' })
  })

  it('fails with the sign-in’s own failure', async () => {
    // The probe saw a clean configuration; the sign-in could not retain its request.
    const blocked = new PendingRequestUnusable({ reason: 'session storage is blocked' })
    redirectToSignInAtMock.mockReturnValue(Effect.fail(blocked))
    await expect(
      Effect.runPromise(
        Effect.flip(
          redirectToPickedServerSignIn(config, fetchReturning(jsonResponse(SMART_CONFIGURATION)))
        )
      )
    ).resolves.toBe(blocked)
  })

  it('does not redirect at all when the probe is `Unreachable`, returning it for the UI', async () => {
    const support = await Effect.runPromise(
      redirectToPickedServerSignIn(config, fetchRejecting(new TypeError('Failed to fetch')))
    )
    expect(redirectToSignInAtMock).not.toHaveBeenCalled()
    expect(redirectToSelfAddressedSignInReturnMock).not.toHaveBeenCalled()
    expect(support).toEqual(SmartSupport.Unreachable({ reason: 'Failed to fetch' }))
  })
})

// `normalizeServerUrl`'s own behaviour is covered where it lives, in
// `authorization-core/smart-client`'s `server-target.test.ts`; re-exporting is
// only worth anything if it is genuinely the same function.
describe('normalizeServerUrl', () => {
  it('is the one implementation authorization-core owns, not a local copy', () => {
    expect(normalizeServerUrl).toBe(sharedNormalizeServerUrl)
  })
})

describe('insecureTargetReason', () => {
  it('is the one implementation authorization-core owns, not a local copy', () => {
    expect(insecureTargetReason).toBe(sharedInsecureTargetReason)
  })
})
