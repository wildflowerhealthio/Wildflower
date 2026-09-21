import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { Match } from 'effect'
import { normalizeServerUrl as sharedNormalizeServerUrl } from 'gatekeeper-core/smart-client'
import {
  detectSmartSupport,
  normalizeServerUrl,
  startStandaloneLaunch,
} from './standalone-launch.ts'

// `startStandaloneLaunch` reaches fhirclient only through `smart-launch.ts`'s
// lazy `(await import('fhirclient')).default`, so the module boundary is where
// we stub — the same seam `smart-launch.test.ts` uses. `detectSmartSupport`'s
// tests never touch it (they inject `fetchFn`).
const { authorizeMock, readyMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn<(params: Record<string, unknown>) => Promise<void>>(() => Promise.resolve()),
  readyMock: vi.fn(),
}))

vi.mock('fhirclient', () => ({
  default: { oauth2: { authorize: authorizeMock, ready: readyMock } },
}))

beforeEach(() => {
  vi.clearAllMocks()
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

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

describe('detectSmartSupport', () => {
  it('is `smart` when the config names an authorization_endpoint', async () => {
    const support = await detectSmartSupport(
      'https://ehr.example/fhir',
      fetchReturning(jsonResponse({ authorization_endpoint: 'https://ehr.example/authorize' }))
    )
    expect(support).toEqual({ kind: 'smart' })
  })

  it('probes the well-known path with the trailing slash trimmed', async () => {
    const seenUrls: string[] = []
    await detectSmartSupport(
      'https://ehr.example/fhir/',
      fetchReturning(jsonResponse({ authorization_endpoint: 'x' }), seenUrls)
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
    clientId: 'medications-app',
    scope: 'launch openid fhirUser',
    redirectUri: 'https://app.example/',
  }

  it('takes the SMART OAuth path when the probe is `smart`', async () => {
    await startStandaloneLaunch(
      config,
      fetchReturning(jsonResponse({ authorization_endpoint: 'x' }))
    )
    expect(authorizeMock).toHaveBeenCalledTimes(1)
    // The SMART variant carries the client and iss; it never names fhirServiceUrl.
    const arg = authorizeArg()
    expect(arg).toMatchObject({
      clientId: 'medications-app',
      scope: 'launch openid fhirUser',
      redirectUri: 'https://app.example/',
      iss: 'https://ehr.example/fhir',
    })
    expect(arg).not.toHaveProperty('fhirServiceUrl')
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
// `gatekeeper-core/smart-client`'s `server-target.test.ts`. What this file still
// owes is the dedupe itself: this module used to carry a byte-identical copy,
// and re-exporting is only worth anything if it is genuinely the same function.
describe('normalizeServerUrl', () => {
  it('is the one implementation gatekeeper-core owns, not a local copy', () => {
    expect(normalizeServerUrl).toBe(sharedNormalizeServerUrl)
  })
})

// Helpers

/** The options object `authorize` was called with on its first (only) invocation. */
const authorizeArg = (): Record<string, unknown> => {
  const call = authorizeMock.mock.calls[0]
  if (call === undefined) throw new Error('authorize was not called')
  return call[0]
}
