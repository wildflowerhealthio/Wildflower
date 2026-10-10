import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

const configSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'app-config.js'),
  'utf8'
)

/**
 * Runs `config/app-config.js` the way a browser does — a classic script with
 * `window` and `document` in scope — and returns the `window.config` it sets.
 * `document.currentScript` is the only DOM the file touches.
 */
const evaluateConfig = (
  currentScript: { src: string } | null,
  location?: { search: string; hash: string; pathname?: string }
): unknown => {
  const loc = {
    search: location?.search ?? '',
    hash: location?.hash ?? '',
    pathname: location?.pathname ?? '/',
  }
  const window: {
    config?: unknown
    location: typeof loc
    history: { replaceState: typeof replaceState }
  } = {
    location: loc,
    history: { replaceState },
  }
  runInNewContext(configSource, { window, document: { currentScript }, URL, URLSearchParams })
  return window.config
}

let lastReplaceState: { url: string } | undefined
const replaceState = (_data: unknown, _unused: string, url: string): void => {
  lastReplaceState = { url }
}

const isConfig = (value: unknown): value is { routerBasename: string } =>
  typeof value === 'object' &&
  value !== null &&
  'routerBasename' in value &&
  typeof value.routerBasename === 'string'

/** URL path segments: no separators, no dots (so no traversal), not empty. */
const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/)

describe('config/app-config.js', () => {
  it('should derive routerBasename from the directory the script is served from', () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 4 }), (segments) => {
        const dir = segments.length === 0 ? '/' : `/${segments.join('/')}/`
        const config = evaluateConfig({ src: `https://example.test${dir}app-config.js` })
        if (!isConfig(config)) throw new Error('window.config was not set')
        expect(config.routerBasename).toBe(dir)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should fall back to the site root when the script has no URL of its own', () => {
    const config = evaluateConfig(null)
    if (!isConfig(config)) throw new Error('window.config was not set')
    expect(config.routerBasename).toBe('/')
  })

  it('should launch into the FHIR data source from the worklist as the published client', () => {
    const config = evaluateConfig({ src: 'https://wildflowerhealth.io/ohif-viewer/app-config.js' })
    expect(config).toMatchObject({
      routerBasename: '/ohif-viewer/',
      showStudyList: true,
      defaultDataSourceName: 'fhir',
      dataSources: [
        {
          namespace: '@ohif/fhir-viewer.dataSourcesModule.fhir',
          sourceName: 'fhir',
          configuration: {
            smartClientId: 'ohif-viewer',
            smartScope:
              'launch openid fhirUser system/Patient.rs system/ImagingStudy.rs system/DocumentReference.rs',
          },
        },
      ],
    })
  })

  it('should be the debug-only dev client when served from a loopback origin', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('localhost', '127.0.0.1'),
        fc.integer({ min: 1, max: 65535 }),
        (host, port) => {
          const config = evaluateConfig({ src: `http://${host}:${port}/app-config.js` })
          expect(config).toMatchObject({
            routerBasename: '/',
            dataSources: [{ configuration: { smartClientId: 'ohif-viewer-dev' } }],
          })
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should never be the dev client on any other host', () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['https'] }), (url) => {
        const origin = new URL(url).origin
        fc.pre(!/^https:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin))
        const config = evaluateConfig({ src: `${origin}/app-config.js` })
        expect(config).toMatchObject({
          dataSources: [{ configuration: { smartClientId: 'ohif-viewer' } }],
        })
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should restore a redirect path from 404.html into the browser URL', () => {
    lastReplaceState = undefined
    evaluateConfig(
      { src: 'https://wildflowerhealth.io/ohif-viewer/app-config.js' },
      { search: '?redirect=/fhir-viewer&iss=https%3A%2F%2Fexample.com', hash: '' }
    )
    expect(lastReplaceState).toEqual({
      url: '/ohif-viewer/fhir-viewer?iss=https%3A%2F%2Fexample.com',
    })
  })

  it('should strip the basename prefix from the redirect path', () => {
    lastReplaceState = undefined
    evaluateConfig(
      { src: 'https://wildflowerhealth.io/ohif-viewer/app-config.js' },
      { search: '?redirect=/ohif-viewer/fhir-viewer', hash: '' }
    )
    expect(lastReplaceState).toEqual({ url: '/ohif-viewer/fhir-viewer' })
  })

  it('should preserve the hash fragment through the redirect', () => {
    lastReplaceState = undefined
    evaluateConfig(
      { src: 'https://wildflowerhealth.io/ohif-viewer/app-config.js' },
      { search: '?redirect=/fhir-viewer', hash: '#study=1' }
    )
    expect(lastReplaceState).toEqual({ url: '/ohif-viewer/fhir-viewer#study=1' })
  })

  it('should not call replaceState when there is no redirect param', () => {
    lastReplaceState = undefined
    evaluateConfig(
      { src: 'https://wildflowerhealth.io/ohif-viewer/app-config.js' },
      { search: '?iss=https%3A%2F%2Fexample.com', hash: '' }
    )
    expect(lastReplaceState).toBeUndefined()
  })
})
