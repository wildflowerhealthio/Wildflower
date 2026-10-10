import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { docSources } from './sources.ts'
import type { OpenApiDocument } from './spec.ts'
import { BEARER_SCHEME_NAME, preparedSpec, withBearerAuth, withServer } from './spec.ts'

/** Snapshot-shaped documents: arbitrary root keys, none of the ones we set. */
const otherRootKeys = fc
  .dictionary(
    fc
      .string({ minLength: 1 })
      .filter((key) => !['servers', 'security', 'components'].includes(key)),
    fc.jsonValue(),
    { maxKeys: 5 }
  )
  .map((entries): OpenApiDocument => entries)

const serverUrl = fc.webUrl({ size: 'small' })

describe('withServer', () => {
  it('replaces the server list with exactly the chosen target', () => {
    fc.assert(
      fc.property(otherRootKeys, serverUrl, (spec, url) => {
        const result = withServer({ ...spec, servers: [{ url: 'http://stale.test' }] }, url)
        expect(result.servers).toEqual([{ url }])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('leaves every other part of the document alone', () => {
    fc.assert(
      fc.property(otherRootKeys, serverUrl, (spec, url) => {
        const result = withServer(spec, url)
        for (const key of Object.keys(spec)) {
          expect(result[key]).toEqual(spec[key])
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('withBearerAuth', () => {
  it('declares an HTTP bearer scheme and requires it by default', () => {
    const result = withBearerAuth({ openapi: '3.1.0' })
    expect(result.components).toMatchObject({
      securitySchemes: { [BEARER_SCHEME_NAME]: { type: 'http', scheme: 'bearer' } },
    })
    expect(result.security).toEqual([{ [BEARER_SCHEME_NAME]: [] }])
  })

  it('keeps schemes and component sections a snapshot already declares', () => {
    const result = withBearerAuth({
      components: {
        schemas: { Widget: { type: 'object' } },
        securitySchemes: { apiKey: { type: 'apiKey', name: 'X-Key', in: 'header' } },
      },
    })
    expect(result.components).toMatchObject({
      schemas: { Widget: { type: 'object' } },
      securitySchemes: {
        apiKey: { type: 'apiKey', name: 'X-Key', in: 'header' },
        [BEARER_SCHEME_NAME]: { type: 'http', scheme: 'bearer' },
      },
    })
  })

  it('survives a components section that is not an object', () => {
    // The transform must not throw on a malformed document — a broken snapshot
    // should still render, just without inheriting nonsense.
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.constant(undefined)), (components) => {
        const result = withBearerAuth({ components })
        expect(result.security).toEqual([{ [BEARER_SCHEME_NAME]: [] }])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('preparedSpec', () => {
  it('is the composition of both transforms', () => {
    fc.assert(
      fc.property(otherRootKeys, serverUrl, (spec, url) => {
        expect(preparedSpec(spec, url)).toEqual(withBearerAuth(withServer(spec, url)))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('makes every shipped slice snapshot sendable against the chosen server', () => {
    // Runs against the real committed snapshots this page bundles, so a
    // snapshot that stopped being a usable OpenAPI document fails here.
    expect(docSources.length).toBe(6)
    for (const source of docSources) {
      const result = preparedSpec(source.spec, 'https://example-tunnel-origin')
      expect(result.servers).toEqual([{ url: 'https://example-tunnel-origin' }])
      expect(result.security).toEqual([{ [BEARER_SCHEME_NAME]: [] }])
      const paths = result.paths
      if (typeof paths !== 'object' || paths === null) throw new Error(`${source.slug}: no paths`)
      expect(Object.keys(paths).length).toBeGreaterThan(0)
      // The snapshot's own operations are untouched by the transforms.
      expect(result.paths).toEqual(source.spec.paths)
    }
  })
})
