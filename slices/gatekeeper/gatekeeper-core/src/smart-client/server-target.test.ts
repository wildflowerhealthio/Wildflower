import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  normalizeServerUrl,
  searchAfterArrivingLaunch,
  SERVER_QUERY_PARAM,
  searchWithServerUrl,
  serverUrlNamedBy,
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

describe('serverUrlNamedBy', () => {
  it('names a Wildflower server by its API base, less the /fhir-r4 mount', () => {
    expect(serverUrlNamedBy('https://ruth.wildflowerhealth.io/fhir-r4')).toBe(
      'https://ruth.wildflowerhealth.io'
    )
    expect(serverUrlNamedBy('https://example.org/wildflower/fhir-r4/')).toBe(
      'https://example.org/wildflower'
    )
  })

  it('takes any other FHIR base as it is', () => {
    expect(serverUrlNamedBy('https://launch.smarthealthit.org/v/r4/fhir')).toBe(
      'https://launch.smarthealthit.org/v/r4/fhir'
    )
    expect(serverUrlNamedBy('https://example.org/fhir-r4x')).toBe('https://example.org/fhir-r4x')
  })

  it('reads the mount off the canonical form: no query, fragment or stray slashes', () => {
    expect(serverUrlNamedBy('https://ruth.wildflowerhealth.io/fhir-r4/?a=1#top')).toBe(
      'https://ruth.wildflowerhealth.io'
    )
    expect(serverUrlNamedBy('https://example.org/wildflower//fhir-r4')).toBe(
      'https://example.org/wildflower'
    )
    expect(serverUrlNamedBy('http://127.0.0.1:8080/fhir-r4')).toBe('http://127.0.0.1:8080')
  })

  it('names nothing for a URL a page would not send requests to', () => {
    expect(serverUrlNamedBy('javascript:alert(1)')).toBeUndefined()
  })

  it('property: is the canonical form of the URL, with any /fhir-r4 mount gone', () => {
    fc.assert(
      fc.property(httpUrl, fc.boolean(), (serverUrl, mounted) => {
        // Arrange
        const canonical = normalizeServerUrl(serverUrl)
        fc.pre(canonical !== undefined && !canonical.endsWith('/fhir-r4'))
        const iss = mounted ? `${canonical}/fhir-r4` : serverUrl

        // Act / Assert
        expect(serverUrlNamedBy(iss)).toBe(canonical)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('searchAfterArrivingLaunch', () => {
  it('points the page at the server a launch names, over ?server=, and takes the launch out', () => {
    // Arrange — the base opening a server's launcher, on a link that also
    // carried another server
    const search = `?server=${encodeURIComponent('https://other.example')}&iss=${encodeURIComponent(
      'https://ruth.wildflowerhealth.io/fhir-r4'
    )}&launch=nonce-1&tab=logs`

    // Act
    const settled = new URLSearchParams(searchAfterArrivingLaunch(search))

    // Assert
    expect(settled.get(SERVER_QUERY_PARAM)).toBe('https://ruth.wildflowerhealth.io')
    expect(settled.has('iss')).toBe(false)
    expect(settled.has('launch')).toBe(false)
    expect(settled.get('tab')).toBe('logs')
  })

  it('points the page at the server a standalone launch names', () => {
    // Act / Assert — `iss` alone
    expect(
      searchAfterArrivingLaunch(
        `?iss=${encodeURIComponent('https://ruth.wildflowerhealth.io/fhir-r4/')}`
      )
    ).toBe(`?server=${encodeURIComponent('https://ruth.wildflowerhealth.io')}`)
  })

  it('leaves a load that is no launch as it is', () => {
    // Arrange — a lone `launch` names no server; a return leg is never a launch
    const loneLaunch = `?server=${encodeURIComponent('https://other.example')}&launch=nonce-1`
    const returnLeg = `?iss=${encodeURIComponent('https://ruth.wildflowerhealth.io')}&code=c&state=s`

    // Act / Assert
    expect(searchAfterArrivingLaunch(loneLaunch)).toBe(loneLaunch)
    expect(searchAfterArrivingLaunch(returnLeg)).toBe(returnLeg)
  })

  it('keeps ?server= when the launch’s iss names no usable server', () => {
    // Arrange
    const search = `?server=${encodeURIComponent('https://other.example')}&iss=javascript%3Aalert(1)&launch=nonce-1`

    // Act / Assert
    expect(searchAfterArrivingLaunch(search)).toBe(
      `?server=${encodeURIComponent('https://other.example')}`
    )
  })

  it('property: never leaves a launch in the URL', () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.string({ minLength: 1 }),
        fc.option(fc.webUrl(), { nil: undefined }),
        (iss, launch, server) => {
          // Arrange
          const params = new URLSearchParams({ iss, launch })
          if (server !== undefined) params.set(SERVER_QUERY_PARAM, server)

          // Act
          const settled = new URLSearchParams(searchAfterArrivingLaunch(`?${params.toString()}`))

          // Assert
          expect(settled.has('iss')).toBe(false)
          expect(settled.has('launch')).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
