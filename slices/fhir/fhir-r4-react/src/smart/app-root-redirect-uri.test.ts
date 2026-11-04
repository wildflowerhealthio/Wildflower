import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { appRootRedirectUri } from './app-root-redirect-uri.ts'

describe('appRootRedirectUri', () => {
  it('should name the app root from a launch it was opened with, dropping the launch', () => {
    // Act / Assert — the EHR launch starts at the app root itself
    expect(
      appRootRedirectUri(
        'https://importer.wildflowerhealth.io/?iss=https%3A%2F%2Fehr.example&launch=xyz'
      )
    ).toBe('https://importer.wildflowerhealth.io/')
  })

  it('should name the app root itself from a page at the root, dropping its query and fragment', () => {
    // Act / Assert — the connect menu, and a callback carrying code/state
    expect(appRootRedirectUri('https://importer.wildflowerhealth.io/')).toBe(
      'https://importer.wildflowerhealth.io/'
    )
    expect(appRootRedirectUri('https://importer.wildflowerhealth.io/?code=abc&state=xyz#x')).toBe(
      'https://importer.wildflowerhealth.io/'
    )
  })

  it('should keep a dev server’s origin, over plain http off loopback too', () => {
    // Act / Assert — no scheme screen: a LAN dev server derives its own root
    expect(appRootRedirectUri('http://127.0.0.1:5191/?iss=x')).toBe('http://127.0.0.1:5191/')
    expect(appRootRedirectUri('http://192.168.1.20:5191/')).toBe('http://192.168.1.20:5191/')
  })

  it('should name the basepath from a deep route of a routed app', () => {
    // Act / Assert — a launch at a nested route returns to the app root
    expect(
      appRootRedirectUri('https://apps.example/pr-7/patients/123/today?iss=x&launch=y#z', '/pr-7/')
    ).toBe('https://apps.example/pr-7/')
    expect(appRootRedirectUri('https://u:p@apps.example/patients/1.50/plan', '/')).toBe(
      'https://u:p@apps.example/'
    )
  })

  it('should give every page in one directory, whatever it carries, the same root', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', 'index.html'),
        nonCallbackParams(),
        fc.string(),
        (page, params, fragment) => {
          // Arrange
          const href = `https://apps.example/some/app/${page}${searchFrom(params)}#${encodeURIComponent(fragment)}`

          // Act / Assert
          expect(appRootRedirectUri(href)).toBe('https://apps.example/some/app/')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

/** A query string built from `params`, leading `?` included. */
const searchFrom = (params: Record<string, string>): string =>
  `?${new URLSearchParams(params).toString()}`

/** Arbitrary query params that are never `code`, `state`, or `error`. */
const nonCallbackParams = (): fc.Arbitrary<Record<string, string>> =>
  fc.dictionary(fc.string(), fc.string()).map((dict) => {
    const copy = { ...dict }
    for (const key of ['code', 'state', 'error']) delete copy[key]
    return copy
  })
