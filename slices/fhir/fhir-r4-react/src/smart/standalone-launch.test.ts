import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  insecureTargetReason as sharedInsecureTargetReason,
  normalizeServerUrl as sharedNormalizeServerUrl,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Match } from 'effect'
import {
  detectSmartSupport,
  insecureTargetReason,
  normalizeServerUrl,
  startStandaloneLaunch,
} from './standalone-launch.ts'

// `startStandaloneLaunch` reaches fhirclient only through `smart-launch.ts`'s
// lazy `(await import('fhirclient')).default`, so the module boundary is where
// we stub — the same seam `smart-launch.test.ts` uses. `detectSmartSupport`'s
// tests never touch it (they inject `fetchFn`).
const { authorizeMock, readyMock, assignMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn<(params: Record<string, unknown>) => Promise<string | void>>(),
  readyMock: vi.fn(),
  assignMock: vi.fn<(url: string) => void>(),
}))

vi.mock('fhirclient', () => ({
  default: { oauth2: { authorize: authorizeMock, ready: readyMock } },
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Asked with `noRedirect`, fhirclient answers the URL it would have gone to;
  // the page is an https one whose `assign` records where it was sent.
  authorizeMock.mockResolvedValue('https://ehr.example/authorize?state=xyz')
  vi.stubGlobal('location', { protocol: 'https:', assign: assignMock })
})

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

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

describe('detectSmartSupport', () => {
  it('is `smart` when the config names usable endpoints', async () => {
    const support = await detectSmartSupport(
      'https://ehr.example/fhir',
      fetchReturning(jsonResponse(SMART_CONFIGURATION))
    )
    expect(support).toEqual({ kind: 'smart' })
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
  ])('is `unusable`, with the discovery reason, for $case', async ({ configuration }) => {
    const support = await detectSmartSupport(
      'https://ehr.example/fhir',
      fetchReturning(jsonResponse(configuration)),
      true
    )
    expect(support).toEqual({
      kind: 'unusable',
      reason:
        'The server’s SMART configuration does not advertise a usable ' +
        'authorization_endpoint and token_endpoint over https (or loopback).',
    })
  })

  it('is `unusable` when the config names an authorization_endpoint but no token_endpoint', async () => {
    const support = await detectSmartSupport(
      'https://ehr.example/fhir',
      fetchReturning(jsonResponse({ authorization_endpoint: 'https://ehr.example/authorize' })),
      true
    )
    expect(support).toMatchObject({ kind: 'unusable' })
  })

  it('is `smart` for a plain-http endpoint when the page is itself http', async () => {
    const support = await detectSmartSupport(
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
    expect(support).toEqual({ kind: 'smart' })
  })

  it('reads whether the page is secure off the page by default', async () => {
    // The https page stubbed above: a plain-http endpoint off loopback is unusable
    const support = await detectSmartSupport(
      'https://ehr.example/fhir',
      fetchReturning(
        jsonResponse({ ...SMART_CONFIGURATION, authorization_endpoint: 'http://ehr.example/a' })
      )
    )
    expect(support).toMatchObject({ kind: 'unusable' })
  })

  it('probes the well-known path with the trailing slash trimmed', async () => {
    const seenUrls: string[] = []
    await detectSmartSupport(
      'https://ehr.example/fhir/',
      fetchReturning(jsonResponse(SMART_CONFIGURATION), seenUrls)
    )
    expect(seenUrls).toEqual(['https://ehr.example/fhir/.well-known/smart-configuration'])
  })

  it('is `open` on a non-ok HTTP answer (the server has no SMART config)', async () => {
    const support = await detectSmartSupport(
      'https://open.example/fhir',
      fetchReturning(new Response(null, { status: 404 }))
    )
    expect(support).toEqual({ kind: 'open' })
  })

  it('is `open` when the config carries no authorization_endpoint', async () => {
    const support = await detectSmartSupport(
      'https://open.example/fhir',
      fetchReturning(jsonResponse({ token_endpoint: 'https://open.example/token' }))
    )
    expect(support).toEqual({ kind: 'open' })
  })

  it('is `open` when the ok response is not JSON', async () => {
    const support = await detectSmartSupport(
      'https://open.example/fhir',
      fetchReturning(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }))
    )
    expect(support).toEqual({ kind: 'open' })
  })

  it('is `unreachable` (not `open`) when the probe rejects — a CORS/down server is not open access', async () => {
    const support = await detectSmartSupport(
      'https://blocked.example/fhir',
      fetchRejecting(new TypeError('Failed to fetch'))
    )
    expect(support).toEqual({ kind: 'unreachable', message: 'Failed to fetch' })
  })
})

describe('startStandaloneLaunch', () => {
  const config = {
    iss: 'https://ehr.example/fhir',
    clientId: '9769f8b274370708d0d3ebb2e3e59b7c',
    scope: 'launch openid fhirUser',
    redirectUri: 'https://app.example/',
  }

  it('takes the SMART OAuth path when the probe is `smart`', async () => {
    await startStandaloneLaunch(config, fetchReturning(jsonResponse(SMART_CONFIGURATION)))
    expect(authorizeMock).toHaveBeenCalledTimes(1)
    // The SMART variant carries the client and iss; it never names fhirServiceUrl.
    const arg = authorizeArg()
    expect(arg).toMatchObject({
      clientId: '9769f8b274370708d0d3ebb2e3e59b7c',
      scope: 'launch openid fhirUser',
      redirectUri: 'https://app.example/',
      iss: 'https://ehr.example/fhir',
    })
    expect(arg).not.toHaveProperty('fhirServiceUrl')
    expect(assignMock).toHaveBeenCalledWith('https://ehr.example/authorize?state=xyz')
  })

  it('takes the open (no-auth) path when the probe is `open`', async () => {
    await startStandaloneLaunch(config, fetchReturning(new Response(null, { status: 404 })))
    expect(authorizeMock).toHaveBeenCalledTimes(1)
    // The open variant names fhirServiceUrl and the redirect only — no client,
    // scope, or iss, so no auth handshake is attempted.
    const arg = authorizeArg()
    expect(arg).toMatchObject({
      fhirServiceUrl: 'https://ehr.example/fhir',
      redirectUri: 'https://app.example/',
    })
    expect(arg).not.toHaveProperty('clientId')
    expect(arg).not.toHaveProperty('scope')
    expect(arg).not.toHaveProperty('iss')
  })

  it('does not authorize at all when the probe is `unusable`, returning it for the UI', async () => {
    const support = await startStandaloneLaunch(
      config,
      fetchReturning(
        jsonResponse({ ...SMART_CONFIGURATION, authorization_endpoint: 'javascript:alert(1)' })
      )
    )
    expect(authorizeMock).not.toHaveBeenCalled()
    expect(assignMock).not.toHaveBeenCalled()
    expect(support).toMatchObject({ kind: 'unusable' })
  })

  it('rejects, without navigating, when the authorize URL fhirclient builds is unusable', async () => {
    // The probe saw a clean configuration; fhirclient's own fetch of it did not.
    authorizeMock.mockResolvedValue('javascript:alert(1)//?state=xyz')
    await expect(
      startStandaloneLaunch(config, fetchReturning(jsonResponse(SMART_CONFIGURATION)))
    ).rejects.toThrow('It is a javascript: URL')
    expect(assignMock).not.toHaveBeenCalled()
  })

  it('does not authorize at all when the probe is `unreachable`, returning it for the UI', async () => {
    const support = await startStandaloneLaunch(
      config,
      fetchRejecting(new TypeError('Failed to fetch'))
    )
    expect(authorizeMock).not.toHaveBeenCalled()
    expect(support).toEqual({ kind: 'unreachable', message: 'Failed to fetch' })
  })
})

// `normalizeServerUrl`'s own behaviour is covered where it now lives, in
// `authorization-core/smart-client`'s `server-target.test.ts`. What this file still
// owes is the dedupe itself: this module used to carry a byte-identical copy,
// and re-exporting is only worth anything if it is genuinely the same function.
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

// Helpers

/** The options object `authorize` was called with on its first (only) invocation. */
const authorizeArg = (): Record<string, unknown> => {
  const call = authorizeMock.mock.calls[0]
  if (call === undefined) throw new Error('authorize was not called')
  return call[0]
}
