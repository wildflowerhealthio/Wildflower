import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { Match } from 'effect'
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

/** Schemes a picked FHIR base must never be able to smuggle in. */
const dangerousScheme = fc.constantFrom(
  'javascript',
  'data',
  'vbscript',
  'file',
  'blob',
  'ftp',
  'ws',
  'wss',
  'tauri'
)

/** Absolute `http(s)` URLs, the only inputs this app accepts. */
const httpUrl = fc.webUrl({ withQueryParameters: true, withFragments: true, size: 'small' })

describe('normalizeServerUrl', () => {
  it('accepts an absolute http(s) URL and drops query, fragment and userinfo', () => {
    expect(normalizeServerUrl('http://127.0.0.1:8080/fhir-r4')).toBe(
      'http://127.0.0.1:8080/fhir-r4'
    )
    expect(normalizeServerUrl('  https://launch.smarthealthit.org/v/r4/fhir/  ')).toBe(
      'https://launch.smarthealthit.org/v/r4/fhir'
    )
    expect(normalizeServerUrl('https://example.test/fhir/?a=1#frag')).toBe(
      'https://example.test/fhir'
    )
    expect(normalizeServerUrl('https://user:secret@example.test')).toBe('https://example.test')
  })

  it('rejects every scheme the FHIR client could not (or must not) use', () => {
    fc.assert(
      fc.property(dangerousScheme, fc.string(), (scheme, rest) => {
        expect(normalizeServerUrl(`${scheme}:${rest}`)).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('rejects the classic injection payloads and non-absolute inputs exactly', () => {
    expect(normalizeServerUrl('javascript:alert(1)')).toBeUndefined()
    expect(normalizeServerUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    // Protocol-relative and relative inputs have no scheme to parse against —
    // there is deliberately no base URL, so they cannot inherit this page's.
    expect(normalizeServerUrl('//evil.example')).toBeUndefined()
    expect(normalizeServerUrl('/fhir-r4')).toBeUndefined()
    expect(normalizeServerUrl('evil.example:8080')).toBeUndefined()
    expect(normalizeServerUrl('')).toBeUndefined()
    expect(normalizeServerUrl('   ')).toBeUndefined()
    expect(normalizeServerUrl('http://')).toBeUndefined()
  })

  it('is idempotent and never invents a scheme or a trailing slash', () => {
    fc.assert(
      fc.property(httpUrl, (url) => {
        const once = normalizeServerUrl(url)
        expect(once).toBeDefined()
        const value = once ?? ''
        expect(normalizeServerUrl(value)).toBe(value)
        expect(value.startsWith('http://') || value.startsWith('https://')).toBe(true)
        expect(value).not.toContain('#')
        expect(value).not.toContain('?')
        expect(value.endsWith('/')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

// Helpers

/** The options object `authorize` was called with on its first (only) invocation. */
const authorizeArg = (): Record<string, unknown> => {
  const call = authorizeMock.mock.calls[0]
  if (call === undefined) throw new Error('authorize was not called')
  return call[0]
}
