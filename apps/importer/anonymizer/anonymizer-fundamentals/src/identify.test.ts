import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { DecodeFailure, type AnonymizerFormatDescriptor } from './format-descriptor.ts'
import { acceptFor, identify } from './identify.ts'
import type { PickedFile } from './picked-file.ts'

describe('identify', () => {
  it('should route to the descriptor whose detect claims the file', () => {
    // Arrange
    const har = byExtension('har', '.har', ['.har'])
    const pdf = byExtension('pdf', '.pdf', ['.pdf'])

    // Act / Assert
    expect(identify([pdf, har], file('report.pdf'))).toBe(pdf)
    expect(identify([pdf, har], file('capture.har'))).toBe(har)
  })

  it('should return undefined when no descriptor claims the file', () => {
    // Arrange
    const har = byExtension('har', '.har', ['.har'])

    // Act
    const found = identify([har], file('notes.txt'))

    // Assert
    expect(found).toBeUndefined()
  })

  it('should prefer the earliest descriptor when several claim the file', () => {
    // Arrange
    const eager = claimingAll('eager')
    const alsoEager = claimingAll('also-eager')

    // Act
    const found = identify([eager, alsoEager], file('anything'))

    // Assert
    expect(found).toBe(eager)
  })

  it('should never route past a claiming descriptor nor to a declining one', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean()), fc.string(), (claims, fileName) => {
        // Arrange
        const descriptors = claims.map((claimed, index) => ({
          ...claimingAll(`format-${String(index)}`),
          detect: () => claimed,
        }))
        const firstClaiming = claims.indexOf(true)

        // Act
        const found = identify(descriptors, file(fileName))

        // Assert
        expect(found).toBe(firstClaiming === -1 ? undefined : descriptors[firstClaiming])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('acceptFor', () => {
  it('should join every format’s accept tokens, deduplicated in first-seen order', () => {
    // Arrange
    const har = byExtension('har', '.har', ['.har', 'application/json'])
    const pdf = byExtension('pdf', '.pdf', ['.pdf', 'application/json'])

    // Act
    const accept = acceptFor([har, pdf])

    // Assert
    expect(accept).toBe('.har,application/json,.pdf')
  })

  it('should be empty for an empty registry', () => {
    expect(acceptFor([])).toBe('')
  })
})

// Helpers

/** A descriptor claiming files whose name ends with the given extension. */
const byExtension = (
  format: string,
  extension: string,
  accept: readonly string[]
): AnonymizerFormatDescriptor<unknown> => ({
  format,
  display: { title: format, description: `the ${format} format` },
  accept,
  detect: (candidate) => candidate.fileName.endsWith(extension),
  decode: () => Effect.fail(new DecodeFailure({ message: 'unused in these tests' })),
})

/** A descriptor claiming every file. */
const claimingAll = (format: string): AnonymizerFormatDescriptor<unknown> =>
  byExtension(format, '', [])

const file = (fileName: string): PickedFile => ({ fileName, bytes: new Uint8Array() })
