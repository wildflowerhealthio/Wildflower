import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import { emitHar, HarFromJson, HttpArchive } from 'http-archive'
import type { DocumentReferenceType } from 'importer-fundamentals'
import {
  HAR_ARCHIVE_CODE,
  isWebTrace,
  toDocumentReference,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from 'web-trace-core/codec'
import { arbitraries } from 'web-trace-core/test-helpers'

import {
  HAR_ARCHIVE_CATEGORY_TOKEN,
  HAR_ARCHIVE_CONTENT_TYPE,
  harArchiveFromDocumentReference,
  isHarArchive,
  sourceArchive,
} from './har-archive-codec.ts'

/**
 * The shared codec machinery — round trip, hash/size, `subject`, verbatim
 * bytes, the deterministic id — is pinned once in
 * `importer-fundamentals`' `source-archive-codec.test.ts`. This file asserts
 * only what is HAR-specific: the web-trace coding and raw security label, and
 * the two seams a HAR archive alone touches — disjointness from a captured
 * trace, and that the stored bytes still read as an HTTP Archive.
 */

const { exchange: exchangeArbitrary } = arbitraries(fc)

/** Mint a HAR archive resource from picked bytes — the descriptor's own entry point. */
const mint = (bytes: Uint8Array, fileName = 'portal-session.har'): Promise<DocumentReferenceType> =>
  Effect.runPromise(sourceArchive({ fileName, bytes }))

describe('HAR archive coding', () => {
  it('carries the web-trace har-archive coding on type and category, the raw label, and json content', async () => {
    const resource = await mint(new TextEncoder().encode('{"log":{"version":"1.2"}}'))

    expect(resource.type?.coding[0]?.system?.toString()).toBe(WEB_TRACE_CODE_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(HAR_ARCHIVE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(WEB_TRACE_CODE_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(HAR_ARCHIVE_CODE)
    expect(resource.securityLabel[0]?.coding[0]?.system?.toString()).toBe(
      WEB_TRACE_REDACTION_SYSTEM
    )
    expect(resource.securityLabel[0]?.coding[0]?.code).toBe(WEB_TRACE_RAW_CODE)
    expect(resource.content[0]?.attachment?.contentType).toBe(HAR_ARCHIVE_CONTENT_TYPE)
    expect(resource.description).toBe('HAR archive: portal-session.har')
    expect(isHarArchive(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(HAR_ARCHIVE_CATEGORY_TOKEN).toBe(`${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE}`)
  })
})

describe('HAR archive vs captured trace', () => {
  test('property: the two document kinds are disjoint — neither predicate sees the other', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 512 }),
        exchangeArbitrary,
        async (bytes, exchange) => {
          const archiveResource = await mint(bytes)
          const traceResource = await Effect.runPromise(toDocumentReference(exchange))

          expect(isHarArchive(archiveResource)).toBe(true)
          expect(isWebTrace(archiveResource)).toBe(false)
          expect(isWebTrace(traceResource)).toBe(true)
          expect(isHarArchive(traceResource)).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a trace resource fails to decode as an archive, naming the coding it wants', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        const outcome = await Effect.runPromise(
          Effect.either(
            harArchiveFromDocumentReference(await Effect.runPromise(toDocumentReference(exchange)))
          )
        )
        expect(outcome._tag).toBe('Left')
        if (outcome._tag === 'Left') expect(outcome.left.message).toContain(HAR_ARCHIVE_CODE)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

test('property: stored bytes still parse as an HTTP Archive after the round trip, which is the point of storing them', async () => {
  // The seam between this codec and the `http-archive` package: an archive is
  // only worth storing if what comes back out is still readable as the file
  // that went in. Nothing here parses the archive — `HttpArchive.LogFromHarJson`
  // does, on the bytes the codec hands back.
  await fc.assert(
    fc.asyncProperty(
      fc.array(exchangeArbitrary, { minLength: 1, maxLength: 4 }),
      async (exchanges) => {
        const fileText = await Effect.runPromise(
          Schema.encode(HarFromJson)(emitHar(exchanges, { sessionId: 'session-0' }))
        )
        const resource = await mint(new TextEncoder().encode(fileText))
        const stored = await Effect.runPromise(harArchiveFromDocumentReference(resource))

        const log = await Effect.runPromise(
          Schema.decodeUnknown(HttpArchive.LogFromHarJson)(new TextDecoder().decode(stored.bytes))
        )
        expect(log.entries.map((entry) => entry.url).toSorted()).toEqual(
          exchanges.map((exchange) => exchange.url).toSorted()
        )
      }
    ),
    { numRuns: numRunsFor({ base: 25 }) }
  )
})
