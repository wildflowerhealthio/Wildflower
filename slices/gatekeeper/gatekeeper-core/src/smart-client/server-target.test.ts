import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  normalizeServerUrl,
  SERVER_QUERY_PARAM,
  searchWithServerUrl,
  serverUrlFromSearch,
} from './server-target.ts'

/** Absolute `http(s)` URLs, the only inputs a page accepts. */
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

  it('strips userinfo from any http(s) URL that carries it, and stays idempotent', () => {
    // Credentials in a `?server=` link would be copied around with it and sent
    // on every request the page makes, so the canonical form must never keep
    // them — whatever the rest of the URL looks like.
    const credentials = fc.stringMatching(/^[A-Za-z0-9._~-]{1,12}$/)
    fc.assert(
      fc.property(httpUrl, credentials, credentials, (url, user, password) => {
        const withUserinfo = new URL(url)
        withUserinfo.username = user
        withUserinfo.password = password

        const normalized = normalizeServerUrl(withUserinfo.toString())

        expect(normalized).toBe(normalizeServerUrl(url))
        expect(normalized).toBeDefined()
        const value = normalized ?? ''
        // A `@` may legitimately sit in the path, so check the parsed userinfo
        // rather than the string.
        expect(new URL(value).username).toBe('')
        expect(new URL(value).password).toBe('')
        expect(normalizeServerUrl(value)).toBe(value)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('serverUrlFromSearch', () => {
  it('reports no target when the parameter is absent, empty or unusable', () => {
    // The default is the app's to choose — this package has no business knowing
    // which server a given page falls back to — so an unusable parameter is
    // `undefined` here rather than a substituted origin.
    expect(serverUrlFromSearch('')).toBeUndefined()
    expect(serverUrlFromSearch('?other=1')).toBeUndefined()
    expect(serverUrlFromSearch('?server=')).toBeUndefined()
    expect(serverUrlFromSearch('?server=javascript:alert(1)')).toBeUndefined()
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
        expect(serverUrlFromSearch(search)).toBe(normalizeServerUrl(candidate))
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
