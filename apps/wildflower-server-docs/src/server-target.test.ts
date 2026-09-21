import * as fc from 'fast-check'
import { normalizeServerUrl, SERVER_QUERY_PARAM } from 'gatekeeper-core/smart-client'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { DEFAULT_SERVER_URL, serverUrlFromSearch } from './server-target.ts'

/** Absolute `http(s)` URLs, the only inputs the console accepts. */
const httpUrl = fc.webUrl({
  withQueryParameters: true,
  withFragments: true,
  size: 'small',
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
