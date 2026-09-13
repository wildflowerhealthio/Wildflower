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
const evaluateConfig = (currentScript: { src: string } | null): unknown => {
  const window: { config?: unknown } = {}
  runInNewContext(configSource, { window, document: { currentScript }, URL })
  return window.config
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

  it('should launch into the FHIR data source from the worklist', () => {
    const config = evaluateConfig({ src: 'https://wildflowerhealth.io/ohif-viewer/app-config.js' })
    expect(config).toMatchObject({
      routerBasename: '/ohif-viewer/',
      showStudyList: true,
      defaultDataSourceName: 'fhir',
      dataSources: [
        {
          namespace: '@ohif/fhir-viewer.dataSourcesModule.fhir',
          sourceName: 'fhir',
        },
      ],
    })
  })
})
