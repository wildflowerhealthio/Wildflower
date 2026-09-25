import { Schema } from 'effect'
import * as fc from 'fast-check'
import { CanadianCodingSystem, CodeableConcept } from 'fhir-r4/data-types'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { CarebookCodingSystem } from '../carebook.ts'
import { promoteMedicationDispense } from './medication-dispense.ts'
import { promoteMedicationRequest } from './medication-request.ts'
import {
  containedMedication,
  decodeRecord,
  decodedVendorDinConcept,
  firstContained,
} from './test-helpers.ts'

describe('promoteMedicationRequest', () => {
  it('should give a contained vendor DIN coding exactly one canonical twin with the same code', () => {
    fc.assert(
      fc.property(dinArbitrary, fc.boolean(), (din, twice) => {
        // Arrange
        const request = {
          ...MedicationRequest.empty,
          contained: [{ ...containedMedication({ id: 'med-1' }), code: vendorDinCode(din) }],
        }

        // Act — a second pass must not add a second canonical coding.
        const once = promoteMedicationRequest(request)
        const promoted = twice ? promoteMedicationRequest(once) : once

        // Assert — additive: the vendor coding is still there, first.
        expect(rawCodingSystemsFor(firstContained(promoted), din)).toEqual([
          CarebookCodingSystem.Din,
          CanadianCodingSystem.Din,
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should give an inline medicationCodeableConcept vendor DIN its canonical twin', () => {
    fc.assert(
      fc.property(dinArbitrary, (din) => {
        // Arrange — no contained Medication, so the inline concept stays put.
        const request = {
          ...MedicationRequest.empty,
          medicationCodeableConcept: decodedVendorDinConcept(din),
        }

        // Act
        const promoted = promoteMedicationRequest(request)

        // Assert
        expect(decodedCodingSystemsFor(promoted.medicationCodeableConcept, din)).toEqual([
          CarebookCodingSystem.Din,
          CanadianCodingSystem.Din,
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should give each distinct contained vendor DIN exactly one canonical twin, keeping every coding it had', () => {
    fc.assert(
      fc.property(dinCodingsArbitrary, (codings) => {
        // Arrange
        const request = {
          ...MedicationRequest.empty,
          contained: [
            {
              ...containedMedication({ id: 'med-1' }),
              code: { coding: codings.map(({ system, code }) => ({ system, code })) },
            },
          ],
        }

        // Act
        const promoted = rawCodingPairsOf(firstContained(promoteMedicationRequest(request)))

        // Assert
        expect(promoted.slice(0, codings.length)).toEqual(codings)
        expect(canonicalCodesIn(promoted)).toEqual(expectedCanonicalCodes(codings))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('promoteMedicationDispense', () => {
  it('should give the dispense medicationCodeableConcept vendor DIN its canonical twin', () => {
    fc.assert(
      fc.property(dinArbitrary, (din) => {
        // Arrange
        const dispense = {
          ...MedicationDispense.empty,
          medicationCodeableConcept: decodedVendorDinConcept(din),
        }

        // Act
        const promoted = promoteMedicationDispense(dispense)

        // Assert
        expect(decodedCodingSystemsFor(promoted.medicationCodeableConcept, din)).toEqual([
          CarebookCodingSystem.Din,
          CanadianCodingSystem.Din,
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should give each distinct concept vendor DIN exactly one canonical twin, keeping every coding it had', () => {
    fc.assert(
      fc.property(dinCodingsArbitrary, (codings) => {
        // Arrange
        const dispense = {
          ...MedicationDispense.empty,
          medicationCodeableConcept: decodedConceptWith(codings),
        }

        // Act
        const promoted = decodedCodingPairsOf(
          promoteMedicationDispense(dispense).medicationCodeableConcept
        )

        // Assert
        expect(promoted.slice(0, codings.length)).toEqual(codings)
        expect(canonicalCodesIn(promoted)).toEqual(expectedCanonicalCodes(codings))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** An 8-digit Health Canada DIN. */
const dinArbitrary = fc.stringMatching(/^\d{8}$/)

/** A coding reduced to the two fields DIN twinning reads. */
interface DinCodingPair {
  readonly system: string
  readonly code: string
}

/**
 * Vendor DIN codings drawn from a shared pool (so codes repeat), then canonical
 * codings for a distinct subset of that pool (so some vendor codes already have
 * their twin).
 */
const dinCodingsArbitrary: fc.Arbitrary<readonly DinCodingPair[]> = fc
  .uniqueArray(dinArbitrary, { minLength: 1 })
  .chain((pool) =>
    fc.tuple(fc.array(fc.constantFrom(...pool), { minLength: 1 }), fc.shuffledSubarray(pool))
  )
  .map(([vendorCodes, canonicalCodes]) => [
    ...vendorCodes.map((code) => ({ system: CarebookCodingSystem.Din, code })),
    ...canonicalCodes.map((code) => ({ system: CanadianCodingSystem.Din, code })),
  ])

/** A decoded `CodeableConcept` carrying exactly `codings`. */
const decodedConceptWith = (codings: readonly DinCodingPair[]): unknown =>
  Schema.decodeUnknownSync(CodeableConcept.Schema)({ coding: codings })

/** The canonical DIN codes in `codings`, sorted, duplicates kept. */
const canonicalCodesIn = (codings: readonly DinCodingPair[]): readonly string[] =>
  codings
    .filter(({ system }) => system === CanadianCodingSystem.Din)
    .map(({ code }) => code)
    .toSorted()

/** Every code the input mentions under either DIN system, once each, sorted. */
const expectedCanonicalCodes = (codings: readonly DinCodingPair[]): readonly string[] =>
  [...new Set(codings.map(({ code }) => code))].toSorted()

/** A decoded `CodeableConcept` read down to the `system`/`code` pair of each coding. */
const DecodedConceptCodingPairs = Schema.Struct({
  coding: Schema.Array(Schema.Struct({ system: Schema.instanceOf(URL), code: Schema.String })),
})

/** The `system`/`code` pair of every decoded `coding`, in order. */
const decodedCodingPairsOf = (concept: unknown): readonly DinCodingPair[] =>
  Schema.decodeUnknownSync(DecodedConceptCodingPairs)(concept).coding.map(({ system, code }) => ({
    system: system.href,
    code,
  }))

/** A raw `CodeableConcept` read down to the `system`/`code` pair of each coding. */
const RawConceptCodingPairs = Schema.Struct({
  coding: Schema.Array(Schema.Struct({ system: Schema.String, code: Schema.String })),
})

/** The `system`/`code` pair of every raw `code.coding` on a contained Medication, in order. */
const rawCodingPairsOf = (medication: Record<string, unknown>): readonly DinCodingPair[] =>
  Schema.decodeUnknownSync(RawConceptCodingPairs)(medication['code']).coding

/** A raw `contained` Medication `code` carrying one carebook vendor DIN coding. */
const vendorDinCode = (din: string): Record<string, unknown> => ({
  coding: [{ system: CarebookCodingSystem.Din, code: din }],
  text: 'Atorvastatin 20 mg tablet',
})

const decodeConcept = Schema.decodeUnknownSync(Schema.typeSchema(CodeableConcept.Schema))

/** The `system` href of every decoded `coding` whose `code` is `din`, in order. */
const decodedCodingSystemsFor = (concept: unknown, din: string): readonly (string | undefined)[] =>
  decodeConcept(concept)
    .coding.filter((coding) => coding.code === din)
    .map((coding) => coding.system?.href)

/** The `system` of every raw `code.coding` on a contained Medication whose `code` is `din`. */
const rawCodingSystemsFor = (
  medication: Record<string, unknown>,
  din: string
): readonly unknown[] => {
  const code = decodeRecord(medication['code'])
  const codings = code['coding']
  return Array.isArray(codings)
    ? codings
        .map((coding: unknown) => decodeRecord(coding))
        .filter((coding) => coding['code'] === din)
        .map((coding) => coding['system'])
    : []
}
