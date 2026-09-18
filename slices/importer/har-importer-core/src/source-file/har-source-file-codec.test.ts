import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import { emitHar, HarFromJson, HttpArchive } from 'http-archive'
import { type DocumentReferenceType, SourceFile } from 'importer-fundamentals'
import {
  HAR_ARCHIVE_CODE,
  isWebTrace,
  toDocumentReference,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from 'web-trace-core/codec'
import { arbitraries } from 'web-trace-core/test-helpers'

import { harImporter } from '../har-importer.ts'

/**
 * The source file this format's importer mints for a picked file — the codec
 * driven under `harImporter`'s own format constants, which is the same context
 * its batch `decode` mints under.
 */
const mint = (bytes: Uint8Array, fileName = 'portal-session.har'): Promise<DocumentReferenceType> =>
  Effect.runPromise(
    SourceFile.mintResource({ fileName, bytes }).pipe(
      Effect.provideService(SourceFile.FormatContext, harImporter.sourceFileFormat)
    )
  )

describe('HAR source file coding', () => {
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
    expect(resource.content[0]?.attachment?.contentType).toBe(harImporter.contentType)
    expect(resource.description).toBe('HAR archive: portal-session.har')
    expect(harImporter.isSourceFile(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(harImporter.categoryToken).toBe(`${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE}`)
  })
})

describe('HAR source file vs captured trace', () => {
  test('property: the two document kinds are disjoint — neither predicate sees the other', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 512 }),
        exchangeArbitrary,
        async (bytes, exchange) => {
          const sourceFileResource = await mint(bytes)
          const traceResource = await Effect.runPromise(toDocumentReference(exchange))

          expect(harImporter.isSourceFile(sourceFileResource)).toBe(true)
          expect(isWebTrace(sourceFileResource)).toBe(false)
          expect(isWebTrace(traceResource)).toBe(true)
          expect(harImporter.isSourceFile(traceResource)).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a trace resource fails to decode as a source file, naming the coding it wants', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        const outcome = await Effect.runPromise(
          Effect.either(
            harImporter.sourceFileFromDocumentReference(
              await Effect.runPromise(toDocumentReference(exchange))
            )
          )
        )
        expect(outcome._tag).toBe('Left')
        if (outcome._tag === 'Left') expect(outcome.left.message).toContain(HAR_ARCHIVE_CODE)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

const { exchange: exchangeArbitrary } = arbitraries(fc)

test('property: stored bytes still parse as an HTTP Archive after the round trip, which is the point of storing them', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(exchangeArbitrary, { minLength: 1, maxLength: 4 }),
      async (exchanges) => {
        const fileText = await Effect.runPromise(
          Schema.encode(HarFromJson)(emitHar(exchanges, { sessionId: 'session-0' }))
        )
        const resource = await mint(new TextEncoder().encode(fileText))
        const stored = await Effect.runPromise(
          harImporter.sourceFileFromDocumentReference(resource)
        )

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
