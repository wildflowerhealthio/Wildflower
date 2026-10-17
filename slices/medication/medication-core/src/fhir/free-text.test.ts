import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { dosageTextOf, noteOf } from './free-text.ts'
import { base, decode } from './test-helpers.ts'

describe('noteOf / dosageTextOf', () => {
  it('should newline-join the non-blank texts, or read null when there are none', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }), (texts) => {
        // A blank optional FHIR string reads as absent; `Annotation.text` is
        // required, so a note carries only non-blank text.
        const present = texts.filter((text) => /\S/.test(text))
        const request = decode({
          ...base,
          note: present.map((text) => ({ text })),
          dosageInstruction: texts.map((text) => ({ text })),
        })
        const expected = present.length > 0 ? present.join('\n') : null
        expect(noteOf(request)).toBe(expected)
        expect(dosageTextOf(request)).toBe(expected)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
