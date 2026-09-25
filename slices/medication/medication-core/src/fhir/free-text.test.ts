import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { dosageTextOf, noteOf } from './free-text.ts'
import { base, decode } from './test-helpers.ts'

describe('noteOf / dosageTextOf', () => {
  it('should newline-join the non-empty texts, or read null when there are none', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }), (texts) => {
        const request = decode({
          ...base,
          note: texts.map((text) => ({ text })),
          dosageInstruction: texts.map((text) => ({ text })),
        })
        const present = texts.filter((text) => text.length > 0)
        const expected = present.length > 0 ? present.join('\n') : null
        expect(noteOf(request)).toBe(expected)
        expect(dosageTextOf(request)).toBe(expected)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
