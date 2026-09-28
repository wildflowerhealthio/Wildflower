import * as fc from 'fast-check'
import { WildflowerExtension } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import { medicationRequestWithIdArb } from './medication-request-arbitrary.ts'
import {
  hasRefill,
  medicationRequestsToMedications,
  medicationRequestsToMedicationViews,
  medicationRequestToMedication,
  medicationRequestToMedicationView,
} from './medication-view.ts'
import {
  base,
  decodeWithId,
  prePromotionRexallRequest,
  prePromotionShoppersRequest,
  rexallRequest,
} from './test-helpers.ts'

/** A bare request — nothing but the required elements and an `id`. */
const bare = { ...base, id: 'mr-bare' }

const RUNS = numRunsFor({ base: 50 })

describe('medicationRequestToMedication', () => {
  test('prefers the codeableConcept text', () => {
    const request = decodeWithId({
      ...base,
      id: 'mr1',
      authoredOn: '2024-01-02T03:04:05Z',
      medicationCodeableConcept: { text: 'Abilify 5 mg', coding: [{ display: 'aripiprazole' }] },
    })
    const med = medicationRequestToMedication(request)
    expect(med.id).toBe('mr1')
    expect(med.displayName).toBe('Abilify 5 mg')
    expect(med.status).toBe('active')
    expect(med.authoredOn).toBe('2024-01-02T03:04:05.000Z')
  })

  test('uses a generic name when the request names no medication', () => {
    const med = medicationRequestToMedication(decodeWithId(bare))
    expect(med.displayName).toBe('Unknown medication')
    expect(med.authoredOn).toBeUndefined()
  })

  it('should key the medication by the request id', () => {
    fc.assert(
      fc.property(medicationRequestWithIdArb, (request) => {
        expect(medicationRequestToMedication(request).id).toBe(request.id)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('medicationRequestsToMedications', () => {
  it('should keep each request id with its request, whatever the input order', () => {
    const requestsAndOrder = fc
      .uniqueArray(medicationRequestWithIdArb, {
        minLength: 1,
        maxLength: 6,
        selector: (request) => request.id,
      })
      .chain((requests) =>
        fc.tuple(
          fc.constant(requests),
          fc.shuffledSubarray(requests, { minLength: requests.length })
        )
      )
    fc.assert(
      fc.property(requestsAndOrder, ([requests, reordered]) => {
        const medications = medicationRequestsToMedications(requests)
        const reorderedMedications = medicationRequestsToMedications(reordered)
        expect(medications.map((medication) => medication.id)).toEqual(
          requests.map((request) => request.id)
        )
        expect(reorderedMedications.map((medication) => medication.id)).toEqual(
          reordered.map((request) => request.id)
        )
        const byId = new Map(medications.map((medication) => [medication.id, medication]))
        for (const medication of reorderedMedications) {
          expect(byId.get(medication.id)).toEqual(medication)
        }
      }),
      { numRuns: RUNS }
    )
  })
})

describe('medicationRequestsToMedicationViews', () => {
  test('keys each view by its request id, in input order', () => {
    const requests = [rexallRequest, bare, prePromotionShoppersRequest].map((request) =>
      decodeWithId(request)
    )
    const views = medicationRequestsToMedicationViews(requests)
    expect(views.map((view) => view.medication.id)).toEqual(['mr-din', 'mr-bare', 'mr-pre-sdm'])
    const reversed = medicationRequestsToMedicationViews(requests.toReversed())
    expect(reversed.map((view) => view.medication.id)).toEqual(['mr-pre-sdm', 'mr-bare', 'mr-din'])
  })
})

describe('medicationRequestToMedicationView', () => {
  test('extracts DIN, description, prescriber, note and both repeat counts', () => {
    const view = medicationRequestToMedicationView(decodeWithId(rexallRequest))
    expect(view.medication.displayName).toBe('Atorvastatin 20 mg tablet')
    expect(view.din).toBe('02241497')
    expect(view.description).toBe('20 mg - Tablet')
    expect(view.requester).toBe('Dr. Jane Smith')
    expect(view.note).toBe('Take with food')
    expect(view.repeatsAllowed).toBe(3)
    // `valueInteger: 0` is a real value, not "missing".
    expect(view.repeatsAvailable).toBe(0)
    // No `expectedSupplyDuration` on this request → no next-fill estimate.
    expect(view.nextFillDate).toBeNull()
  })

  test('leaves every field null when the request carries none of them', () => {
    const view = medicationRequestToMedicationView(decodeWithId(bare))
    expect(view.din).toBeNull()
    expect(view.description).toBeNull()
    expect(view.requester).toBeNull()
    expect(view.note).toBeNull()
    expect(view.repeatsAllowed).toBeNull()
    expect(view.repeatsAvailable).toBeNull()
    expect(view.nextFillDate).toBeNull()
    expect(view.storeLink).toBeNull()
  })

  test('reads no DIN, carebook description, store link or remaining repeats from a pre-promotion resource', () => {
    // A resource in a vendor shape shows only what R4 itself carries; the vendor
    // shapes are not read around. Its description is the dialect's narrative (a
    // copy of the drug name), never the carebook description extension.
    const rexall = medicationRequestToMedicationView(decodeWithId(prePromotionRexallRequest))
    expect(rexall.din).toBeNull()
    expect(rexall.description).toBe('Atorvastatin 20 mg tablet')
    expect(rexall.storeLink).toBeNull()
    expect(rexall.repeatsAvailable).toBeNull()
    expect(rexall.repeatsAllowed).toBe(3)

    const shoppers = medicationRequestToMedicationView(decodeWithId(prePromotionShoppersRequest))
    expect(shoppers.medication.displayName).toBe('LIPITOR')
    expect(shoppers.din).toBeNull()
    expect(shoppers.description).toBeNull()
    expect(shoppers.storeLink).toBeNull()
    expect(shoppers.repeatsAvailable).toBeNull()
  })
})

describe('hasRefill', () => {
  it('should be true only when repeats are allowed and at least one remains', () => {
    fc.assert(
      fc.property(fc.option(fc.nat(5)), fc.option(fc.nat(5)), (allowed, available) => {
        const view = medicationRequestToMedicationView(
          decodeWithId({
            ...bare,
            dispenseRequest: {
              ...(allowed === null ? {} : { numberOfRepeatsAllowed: allowed }),
              extension:
                available === null
                  ? []
                  : [{ url: WildflowerExtension.RepeatsAvailable, valueInteger: available }],
            },
          })
        )
        expect(hasRefill(view)).toBe((allowed ?? 0) > 0 && (available ?? 0) > 0)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
