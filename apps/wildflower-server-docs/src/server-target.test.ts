import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  SERVER_QUERY_PARAM,
  searchWithServerUrl,
  serverUrlFromSearch,
} from './server-target.ts'

/** Absolute `http(s)` URLs, the only inputs the console accepts. */
const httpUrl = fc.webUrl({
  withQueryParameters: true,
  withFragments: true,
  size: 'small',
})

/** Schemes a shared `?server=` link must never be able to smuggle in. */
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

describe('normalizeServerUrl', () => {
  it('accepts an absolute http(s) URL and drops query, fragment and userinfo', () => {
    expect(normalizeServerUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(normalizeServerUrl('  https://example-tunnel-origin/  ')).toBe(
      'https://example-tunnel-origin'
    )
    expect(normalizeServerUrl('https://example.test/api/?a=1#frag')).toBe(
      'https://example.test/api'
    )
    expect(normalizeServerUrl('https://user:secret@example.test')).toBe('https://example.test')
  })

  it('rejects every scheme the request client could not (or must not) use', () => {
    fc.assert(
      fc.property(dangerousScheme, fc.string(), (scheme, rest) => {
        expect(normalizeServerUrl(`${scheme}:${rest}`)).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('rejects the classic injection payloads exactly', () => {
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

describe('serverUrlFromSearch', () => {
  it('has a fallback the console would itself accept', () => {
    // The default comes from `tauri-shared-config.json`; if that file ever
    // described an origin this console rejects, every unparameterised load
    // would silently target nothing.
    expect(normalizeServerUrl(DEFAULT_SERVER_URL)).toBe(DEFAULT_SERVER_URL)
  })

  it('falls back to the host loopback origin when the parameter is absent or unusable', () => {
    expect(serverUrlFromSearch('')).toBe(DEFAULT_SERVER_URL)
    expect(serverUrlFromSearch('?other=1')).toBe(DEFAULT_SERVER_URL)
    expect(serverUrlFromSearch('?server=')).toBe(DEFAULT_SERVER_URL)
    expect(serverUrlFromSearch('?server=javascript:alert(1)')).toBe(DEFAULT_SERVER_URL)
  })

  it('reads the canonical form of an acceptable parameter', () => {
    fc.assert(
      fc.property(httpUrl, (url) => {
        const search = `?${SERVER_QUERY_PARAM}=${encodeURIComponent(url)}`
        expect(serverUrlFromSearch(search)).toBe(normalizeServerUrl(url))
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('searchWithServerUrl', () => {
  it('round-trips any input through the URL: a link always reloads as what it shows', () => {
    fc.assert(
      fc.property(fc.oneof(httpUrl, fc.string()), (candidate) => {
        const search = searchWithServerUrl('', candidate)
        expect(serverUrlFromSearch(search)).toBe(
          normalizeServerUrl(candidate) ?? DEFAULT_SERVER_URL
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('drops the parameter rather than writing a value the next load would ignore', () => {
    expect(searchWithServerUrl('?server=https://kept.test', 'javascript:alert(1)')).toBe('')
    expect(searchWithServerUrl('?a=1&server=https://kept.test', 'nonsense')).toBe('?a=1')
  })

  it('leaves every other query parameter untouched', () => {
    const otherParams = fc.dictionary(
      fc.string({ minLength: 1 }).filter((key) => key !== SERVER_QUERY_PARAM),
      fc.string(),
      { maxKeys: 5 }
    )
    fc.assert(
      fc.property(otherParams, httpUrl, (params, url) => {
        const initial = new URLSearchParams(params).toString()
        const result = new URLSearchParams(searchWithServerUrl(initial, url))
        for (const [key, value] of Object.entries(params)) {
          expect(result.get(key)).toBe(value)
        }
        expect(result.get(SERVER_QUERY_PARAM)).toBe(normalizeServerUrl(url))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
