import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { amortizedDoseOf } from './amortized-dose.ts'
import { firstDoseOf } from './dosage.ts'
import {
  EXCLUDED_REGIMEN_STATUSES,
  medicationRequestsToDoseRegimens,
  medicationRequestToDoseRegimen,
  regimenDoseOf,
} from './dose-regimen.ts'
import { medicationRequestWithIdArb } from './medication-request-arbitrary.ts'
import type { MedicationRequestWithId } from './medication-request-with-id.ts'
import { amortizableRexallRequest, base, decodeWithId } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 50 })

/** A metformin request, overlaid with `overrides` as wire JSON. */
const metformin = (overrides: Record<string, unknown>): MedicationRequestWithId =>
  decodeWithId({
    ...base,
    id: 'mr-metformin',
    authoredOn: '2026-01-01T00:00:00Z',
    medicationCodeableConcept: { text: 'Metformin 500 mg tablet' },
    dosageInstruction: [{ doseAndRate: [{ doseQuantity: { value: 500, unit: 'mg' } }] }],
    ...overrides,
  })

describe('regimenDoseOf', () => {
  test('a stated dose always wins over the amortized one', () => {
    fc.assert(
      fc.property(medicationRequestWithIdArb, (request) => {
        const statedDose = firstDoseOf(request)
        expect(regimenDoseOf(request)).toEqual(statedDose ?? amortizedDoseOf(request))
      }),
      { numRuns: RUNS }
    )
  })

  test('keeps a stated dose even where the supply amortizes to another', () => {
    const regimenDose = regimenDoseOf(
      metformin({
        dispenseRequest: {
          quantity: { value: 60, unit: 'tablet' },
          expectedSupplyDuration: { value: 30, code: 'd' },
        },
      })
    )
    expect(regimenDose).toMatchObject({ amount: 500, per: 'administration', derivation: 'stated' })
  })
})

describe('medicationRequestToDoseRegimen', () => {
  test('an excluded status never yields a regimen', () => {
    fc.assert(
      fc.property(medicationRequestWithIdArb, (request) => {
        if (EXCLUDED_REGIMEN_STATUSES.has(request.status)) {
          expect(medicationRequestToDoseRegimen(request)).toBeNull()
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('the excluded set is exactly cancelled, entered-in-error, draft and unknown', () => {
    expect([...EXCLUDED_REGIMEN_STATUSES].toSorted()).toEqual([
      'cancelled',
      'draft',
      'entered-in-error',
      'unknown',
    ])
  })

  test("a regimen carries its request's id and status, and never ends before it starts", () => {
    fc.assert(
      fc.property(medicationRequestWithIdArb, (request) => {
        const regimen = medicationRequestToDoseRegimen(request)
        if (regimen === null) return
        expect(regimen.requestId).toBe(request.id)
        expect(regimen.status).toBe(request.status)
        if (regimen.end !== null) {
          expect(regimen.end.epochMillis).toBeGreaterThanOrEqual(regimen.start.epochMillis)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('reads the first dose, its unit, the normalized name and the period', () => {
    expect(medicationRequestToDoseRegimen(metformin({}))).toEqual({
      requestId: 'mr-metformin',
      name: 'Metformin 500 mg tablet',
      normalizedName: 'metformin tablet',
      status: 'active',
      amount: 500,
      rangeLow: null,
      unit: 'mg',
      per: 'administration',
      derivation: 'stated',
      start: DateTime.unsafeMake('2026-01-01T00:00:00Z'),
      end: null,
    })
  })

  test('reads a carebook import with no dosage instruction as 10 mg/day, amortized', () => {
    expect(medicationRequestToDoseRegimen(decodeWithId(amortizableRexallRequest))).toMatchObject({
      requestId: 'mr-vyvanse',
      status: 'completed',
      amount: 10,
      rangeLow: null,
      unit: 'mg',
      per: 'd',
      derivation: 'amortized',
      start: DateTime.unsafeMake('2026-03-02T00:00:00Z'),
    })
  })

  test('yields nothing without a readable dose or a start', () => {
    expect(medicationRequestToDoseRegimen(metformin({ dosageInstruction: [] }))).toBeNull()
    expect(medicationRequestToDoseRegimen(metformin({ authoredOn: undefined }))).toBeNull()
  })
})

describe('medicationRequestsToDoseRegimens', () => {
  test('every request lands in exactly one of regimens, undated or dropped', () => {
    fc.assert(
      fc.property(fc.array(medicationRequestWithIdArb, { maxLength: 4 }), (requests) => {
        const { regimens, undated, dropped } = medicationRequestsToDoseRegimens(requests)
        expect(regimens.length + undated + dropped).toBe(requests.length)
      }),
      { numRuns: RUNS }
    )
  })

  test('counts an excluded status or a missing dose as dropped, and a missing start as undated', () => {
    const doseRegimenBatch = medicationRequestsToDoseRegimens([
      metformin({ id: 'mr-usable' }),
      metformin({ id: 'mr-cancelled', status: 'cancelled' }),
      metformin({ id: 'mr-no-dose', dosageInstruction: [] }),
      metformin({ id: 'mr-undated', authoredOn: undefined }),
    ])
    expect(doseRegimenBatch.regimens.map((regimen) => regimen.requestId)).toEqual(['mr-usable'])
    expect(doseRegimenBatch.dropped).toBe(2)
    expect(doseRegimenBatch.undated).toBe(1)
  })
})
