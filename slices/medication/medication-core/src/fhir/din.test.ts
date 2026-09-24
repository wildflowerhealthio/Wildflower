import * as fc from 'fast-check'
import { CanadianCodingSystem } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import { dinOf } from './din.ts'
import {
  base,
  CAREBOOK_DIN_SYSTEM,
  decode,
  rexallRequest,
  shoppersRequest,
} from './test-helpers.ts'

describe('dinOf', () => {
  test('reads the canonical DIN from medicationCodeableConcept', () => {
    expect(dinOf(decode(shoppersRequest))).toBe('02241497')
  })

  test('prefers the contained Medication DIN over the concept fallback', () => {
    const request = decode({
      ...rexallRequest,
      medicationCodeableConcept: {
        coding: [{ system: CanadianCodingSystem.Din, code: 'DO-NOT-USE' }],
      },
    })
    expect(dinOf(request)).toBe('02241497')
  })

  it('should read the canonical DIN from medicationCodeableConcept past any other coding', () => {
    fc.assert(
      fc.property(
        codeArbitrary,
        fc.array(fc.tuple(otherSystemArbitrary, codeArbitrary), { maxLength: 3 }),
        (din, others) => {
          const request = decode({
            ...base,
            medicationCodeableConcept: {
              coding: [
                ...others.map(([system, code]) => ({ system, code })),
                { system: CanadianCodingSystem.Din, code: din },
              ],
            },
          })
          expect(dinOf(request)).toBe(din)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read nothing when no coding is under the canonical DIN system', () => {
    // The vendor carebook DIN system, RxNorm and SNOMED CT alike: a vendor
    // coding always has a canonical twin beside it, and printing a non-DIN code
    // as "DIN …" would be a confidently wrong identifier.
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.option(otherSystemArbitrary), codeArbitrary), { maxLength: 3 }),
        fc.boolean(),
        (codings, onContained) => {
          const code = {
            coding: codings.map(([system, value]) => ({
              ...(system === null ? {} : { system }),
              code: value,
            })),
          }
          const request = decode(
            onContained
              ? { ...base, contained: [{ resourceType: 'Medication', id: 'm', code }] }
              : { ...base, medicationCodeableConcept: code }
          )
          expect(dinOf(request)).toBeNull()
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** A non-empty code with no leading/trailing surprises — DINs are 8 digits, but any code reads. */
const codeArbitrary = fc.stringMatching(/^[0-9A-Za-z]{1,12}$/)

/** Coding systems that are *not* the canonical DIN system. */
const otherSystemArbitrary = fc.constantFrom(
  CAREBOOK_DIN_SYSTEM,
  'http://www.nlm.nih.gov/research/umls/rxnorm',
  'http://snomed.info/sct'
)
