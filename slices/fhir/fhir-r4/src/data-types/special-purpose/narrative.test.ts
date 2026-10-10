import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import * as Narrative from './narrative.ts'

describe('FhirR4Narrative', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(Narrative.Schema), (narrative) => {
        const fhir = Schema.encodeSync(Narrative.Schema)(narrative)
        const decoded = Schema.decodeSync(Narrative.Schema)(fhir)
        expect(decoded).toSchemaEqual(Narrative.Schema, narrative)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('TextFromDiv', () => {
  it('should write text as a single div in the XHTML namespace', () => {
    // Arrange
    const description = '20 mg - Tablet'

    // Act
    const div = encodeDiv(description)

    // Assert
    expect(div).toBe('<div xmlns="http://www.w3.org/1999/xhtml">20 mg - Tablet</div>')
  })

  it('should read the text content out of a generated narrative', () => {
    // Arrange
    const div =
      '<div xmlns="http://www.w3.org/1999/xhtml"><p>Atorvastatin</p>\n  <b>20&nbsp;mg</b> &amp; more</div>'

    // Act
    const text = decodeText(div)

    // Assert — tags become spaces, known entities unescape, unknown ones stay.
    expect(text).toBe('Atorvastatin 20&nbsp;mg & more')
  })

  it('should never let text escape the div it is written into', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        // Act
        const div = encodeDiv(text)

        // Assert — the only markup is the wrapper itself.
        expect(div).toMatch(/^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">[^<>]*<\/div>$/)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read back exactly the text it wrote, when that text is whitespace-collapsed', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^\S+$/), { minLength: 1 }), (words) => {
        // Arrange
        const text = words.join(' ')

        // Act
        const roundTripped = decodeText(encodeDiv(text))

        // Assert
        expect(roundTripped).toBe(text)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const encodeDiv = Schema.encodeSync(Narrative.TextFromDiv)
const decodeText = Schema.decodeSync(Narrative.TextFromDiv)
