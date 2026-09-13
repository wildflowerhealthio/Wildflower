import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { isOmittedFromRecording } from './omitted.ts'

/**
 * The readable statement of the rule. A content type the recorder should start
 * or stop keeping belongs here first; the properties below only say that the
 * shape of the rule holds.
 */
const examples: readonly (readonly [contentType: string, omitted: boolean])[] = [
  // Presentation assets — what a recording is not read for.
  ['text/css', true],
  ['image/png', true],
  ['image/svg+xml', true],
  ['video/mp4', true],
  ['audio/mpeg', true],
  ['font/woff2', true],
  // Kept: the exchanges a reader is after.
  ['application/json', false],
  ['application/fhir+json', false],
  ['text/html', false],
  ['text/xml', false],
  ['application/octet-stream', false],
  // JavaScript is kept on purpose — the divergence from
  // `http-extraction-fundamentals`' `isOmittedContentType`, which drops it.
  ['application/javascript', false],
  ['text/javascript', false],
  ['application/x-javascript', false],
  // `text/css` is named, not reached through `text` — other text is kept.
  ['text/plain', false],
  // Not an image: the recorder matches the top-level type, not a substring.
  ['application/vnd.image', false],
]

describe('isOmittedFromRecording', () => {
  it.each(examples)('should report %s as omitted=%s', (contentType, omitted) => {
    expect(isOmittedFromRecording(contentType)).toBe(omitted)
  })

  it('should omit every subtype of an omitted top-level type', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('image', 'video', 'audio', 'font'),
        fc.stringMatching(/^[a-z0-9]+$/),
        (type, subtype) => {
          // Arrange / Act
          const omitted = isOmittedFromRecording(`${type}/${subtype}`)

          // Assert
          expect(omitted).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never omit a JavaScript or JSON media type, whatever its subtype spelling', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('application', 'text'),
        fc.constantFrom('javascript', 'x-javascript', 'ecmascript', 'json', 'fhir+json'),
        (type, subtype) => {
          // Arrange / Act
          const omitted = isOmittedFromRecording(`${type}/${subtype}`)

          // Assert
          expect(omitted).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
