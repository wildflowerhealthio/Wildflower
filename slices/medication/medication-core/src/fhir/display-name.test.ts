import { CanadianCodingSystem } from 'fhir-r4/data-types'
import { describe, expect, test } from 'vite-plus/test'

import { displayNameOf } from './display-name.ts'
import { base, decode, rexallRequest } from './test-helpers.ts'

describe('displayNameOf', () => {
  test('falls back to the first coding display, even when the coding carries a system', () => {
    // The top-level `medicationCodeableConcept.coding.system` decodes to a `URL`;
    // the concept accessor must still surface the sibling `display`.
    const request = decode({
      ...base,
      medicationCodeableConcept: {
        coding: [{ system: CanadianCodingSystem.Din, display: 'atorvastatin calcium' }],
      },
    })
    expect(displayNameOf(request)).toBe('atorvastatin calcium')
  })

  test('falls back to a medication reference display', () => {
    const request = decode({
      ...base,
      medicationReference: { reference: 'Medication/9', display: 'Actonel DR' },
    })
    expect(displayNameOf(request)).toBe('Actonel DR')
  })

  test('names the contained Medication by its coding when no concept/reference display', () => {
    expect(displayNameOf(decode(rexallRequest))).toBe('Atorvastatin 20 mg tablet')
  })
})
