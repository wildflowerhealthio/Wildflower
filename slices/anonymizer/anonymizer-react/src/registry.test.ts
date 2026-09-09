import { Effect, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { PickedFile } from 'anonymizer-fundamentals'
import { emitHar, HarFromJson } from 'har-importer-core/har'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { HAR_PARSE_ERROR, harDescriptor } from 'har-anonymizer-core'

describe('harDescriptor', () => {
  it('should claim a file named .har whatever its bytes hold', () => {
    fc.assert(
      fc.property(fc.uint8Array(), (bytes) => {
        // Arrange
        const file: PickedFile = { fileName: 'capture.HAR', bytes }

        // Act / Assert
        expect(harDescriptor.detect(file)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should claim JSON-object bytes under any file name', () => {
    // Arrange
    const file = pickedFile('export.json', '  {"log": {}}')

    // Act / Assert
    expect(harDescriptor.detect(file)).toBe(true)
  })

  it('should decline a file that is neither .har-named nor JSON-shaped', () => {
    // Arrange
    const file = pickedFile('report.pdf', '%PDF-1.7 …')

    // Act / Assert
    expect(harDescriptor.detect(file)).toBe(false)
  })

  it('should decode a real archive into its entries', () => {
    // Act
    const log = Effect.runSync(harDescriptor.decode(pickedFile('portal.har', RECOGNIZED_HAR)))

    // Assert
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]?.url).toContain('r4.example.org')
  })

  it('should fail with the HAR parse error on a JSON file that is not a HAR', async () => {
    // Act
    const outcome = await Effect.runPromise(
      Effect.either(harDescriptor.decode(pickedFile('notes.json', '{"not":"a har"}')))
    )

    // Assert
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(outcome.left.message).toBe(HAR_PARSE_ERROR)
  })
})

// Helpers

const pickedFile = (fileName: string, text: string): PickedFile => ({
  fileName,
  bytes: new TextEncoder().encode(text),
})

/** A HAR shaped like a real capture — what matters here is only that it parses. */
const RECOGNIZED_HAR: string = Effect.runSync(
  Schema.encode(HarFromJson)(
    emitHar(
      [
        traceExchange({
          requestId: 'req-0',
          url: 'https://r4.example.org/baseR4/Patient/pat-7?_format=json',
          headers: [['content-type', 'application/fhir+json']],
          body: {
            _tag: 'StoredBody',
            contentType: 'application/fhir+json',
            data: jsonBody({ resourceType: 'Patient', id: 'pat-7' }),
            size: 42,
            hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
          },
          startedAtMillis: CAPTURE_FLOOR,
        }),
      ],
      { sessionId: 'test-session' }
    )
  )
)
