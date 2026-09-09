import { Effect, Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { PickedFile } from 'anonymizer-fundamentals'

import { HAR_PARSE_ERROR, harDescriptor } from 'har-anonymizer-core'
import { RECOGNIZED_HAR } from './test-helpers.ts'

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
