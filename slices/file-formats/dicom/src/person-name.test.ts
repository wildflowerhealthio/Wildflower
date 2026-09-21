import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as PersonName from './person-name.ts'

describe('PersonName.tryFromPnString', () => {
  it('splits family^given into parts', () => {
    const result = PersonName.tryFromPnString('Smith^John')
    expect(result).toEqual({ family: 'Smith', given: 'John', text: 'Smith John' })
  })

  it('handles family only (no caret)', () => {
    const result = PersonName.tryFromPnString('Smith')
    expect(result).toEqual({ family: 'Smith', given: '', text: 'Smith' })
  })

  it('handles multiple components separated by carets', () => {
    const result = PersonName.tryFromPnString('Smith^John^M^Dr^Jr')
    expect(result).toEqual({ family: 'Smith', given: 'John', text: 'Smith John M Dr Jr' })
  })

  it('handles empty components (padding carets)', () => {
    const result = PersonName.tryFromPnString('Smith^^')
    expect(result).toEqual({ family: 'Smith', given: '', text: 'Smith' })
  })

  it('returns undefined for empty string', () => {
    expect(PersonName.tryFromPnString('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', () => {
    expect(PersonName.tryFromPnString('   ')).toBeUndefined()
  })

  it('returns undefined for a delimiters-only value', () => {
    // What a writer emits for an anonymized or absent name. The trimmed value
    // is not empty, so the empty-string guard alone lets it through — and a
    // `{ family: '', given: '', text: '' }` name would reach FHIR synthesis as
    // `name: [{ text: '' }]`, which FHIR `string` forbids, and would derive the
    // same patient id for every such file.
    expect(PersonName.tryFromPnString('^^^')).toBeUndefined()
    expect(PersonName.tryFromPnString('^')).toBeUndefined()
    expect(PersonName.tryFromPnString(' ^ ^ ')).toBeUndefined()
  })

  it('never returns a name whose text is empty', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({
            maxLength: 8,
            unit: fc.constantFrom(...'abc '.split('')),
          }),
          { maxLength: 6 }
        ),
        (components) => {
          const parsed = PersonName.tryFromPnString(components.join('^'))
          if (parsed === undefined) return
          expect(parsed.text.length).toBeGreaterThan(0)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('trims leading/trailing whitespace from components', () => {
    const result = PersonName.tryFromPnString(' Smith ^ John ')
    expect(result).toEqual({ family: 'Smith', given: 'John', text: 'Smith John' })
  })
})
