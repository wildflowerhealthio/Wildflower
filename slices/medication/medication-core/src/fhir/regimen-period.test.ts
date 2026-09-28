import { DateTime } from 'effect'
import * as fc from 'fast-check'
import type { MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { medicationRequestWithIdArb } from './medication-request-arbitrary.ts'
import { regimenEndOf, regimenStartOf } from './regimen-period.ts'
import { base, decode } from './test-helpers.ts'

const at = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso)

/** A request authored on 1 January 2026, overlaid with `overrides` as wire JSON. */
const januaryRequest = (overrides: Record<string, unknown>): MedicationRequest.Type =>
  decode({ ...base, authoredOn: '2026-01-01T00:00:00Z', ...overrides })

describe('regimenStartOf', () => {
  test('is the validity period start, else authoredOn, else null', () => {
    expect(
      regimenStartOf(
        januaryRequest({ dispenseRequest: { validityPeriod: { start: '2026-02-01T00:00:00Z' } } })
      )
    ).toEqual(at('2026-02-01T00:00:00Z'))
    expect(regimenStartOf(januaryRequest({}))).toEqual(at('2026-01-01T00:00:00Z'))
    expect(regimenStartOf(januaryRequest({ authoredOn: undefined }))).toBeNull()
  })
})

describe('regimenEndOf', () => {
  const januaryFirst = at('2026-01-01T00:00:00Z')

  test('never precedes the regimen start', () => {
    fc.assert(
      fc.property(medicationRequestWithIdArb, (request) => {
        const regimenStart = regimenStartOf(request)
        if (regimenStart === null) return
        const regimenEnd = regimenEndOf(request, regimenStart)
        if (regimenEnd === null) return
        expect(regimenEnd.epochMillis).toBeGreaterThanOrEqual(regimenStart.epochMillis)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('is the validity period end before any supply estimate', () => {
    const request = januaryRequest({
      dispenseRequest: {
        validityPeriod: { end: '2026-06-01T00:00:00Z' },
        expectedSupplyDuration: { value: 30, code: 'd' },
      },
    })
    expect(regimenEndOf(request, januaryFirst)).toEqual(at('2026-06-01T00:00:00Z'))
  })

  test('without a validity end, is when the first fill and every repeat have run out', () => {
    const request = januaryRequest({
      dispenseRequest: {
        numberOfRepeatsAllowed: 2,
        expectedSupplyDuration: { value: 30, code: 'd' },
      },
    })
    // Three 30-day fills from 1 January: 90 days.
    expect(regimenEndOf(request, januaryFirst)).toEqual(at('2026-04-01T00:00:00Z'))
  })

  test('with no stated or estimated end, is open while active and the start otherwise', () => {
    expect(regimenEndOf(januaryRequest({ status: 'active' }), januaryFirst)).toBeNull()
    for (const status of ['completed', 'stopped', 'on-hold'] as const) {
      expect(regimenEndOf(januaryRequest({ status }), januaryFirst)).toEqual(januaryFirst)
    }
  })

  test('raises a validity end that precedes the start to the start', () => {
    const request = januaryRequest({
      dispenseRequest: {
        validityPeriod: { start: '2026-05-01T00:00:00Z', end: '2026-04-01T00:00:00Z' },
      },
    })
    expect(regimenEndOf(request, at('2026-05-01T00:00:00Z'))).toEqual(at('2026-05-01T00:00:00Z'))
  })
})
