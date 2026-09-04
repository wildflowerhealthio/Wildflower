import type { Medication } from 'medication-sponsorship-core'
import type { MedicationView } from 'medication-sponsorship-react'
import { describe, expect, it } from 'vite-plus/test'

import { pastEligibleMedications } from './past-medications.ts'

describe('pastEligibleMedications', () => {
  it('returns completed medications not covered by an active prescription', () => {
    const result = pastEligibleMedications([
      view('rx-1', 'Ozempic', 'completed', '2026-05-01T00:00:00Z'),
      view('rx-2', 'Metformin', 'active', '2026-08-01T00:00:00Z'),
    ])

    expect(result.map((medication) => medication.displayName)).toEqual(['Ozempic'])
  })

  it('drops a completed medication whose name has an active prescription', () => {
    // The active Jardiance already earns the eligibility row; the old completed
    // fill of the same drug would be a redundant, dimmed duplicate.
    const result = pastEligibleMedications([
      view('rx-old', 'Jardiance', 'completed', '2026-02-01T00:00:00Z'),
      view('rx-new', 'Jardiance', 'active', '2026-08-01T00:00:00Z'),
    ])

    expect(result).toEqual([])
  })

  it('keeps only the most recent of duplicate completed names', () => {
    const result = pastEligibleMedications([
      view('rx-older', 'Ozempic', 'completed', '2026-01-01T00:00:00Z'),
      view('rx-newer', 'Ozempic', 'completed', '2026-06-01T00:00:00Z'),
    ])

    expect(result.map((medication) => medication.id)).toEqual(['rx-newer'])
  })

  it('ignores statuses that are neither active nor completed', () => {
    const result = pastEligibleMedications([
      view('rx-stopped', 'Ramipril', 'stopped', '2026-03-01T00:00:00Z'),
      view('rx-cancelled', 'Warfarin', 'cancelled', '2026-03-01T00:00:00Z'),
    ])

    expect(result).toEqual([])
  })
})

// Helpers

const medication = (
  id: string,
  displayName: string,
  status: string,
  authoredOn: string
): Medication => ({ id, displayName, status, authoredOn })

const view = (
  id: string,
  displayName: string,
  status: string,
  authoredOn: string
): MedicationView => ({
  medication: medication(id, displayName, status, authoredOn),
  din: null,
  description: null,
  requester: null,
  note: null,
  repeatsAllowed: null,
  repeatsAvailable: null,
  nextFillDate: null,
  rexallStoreUrl: null,
  shoppersStoreUrl: null,
})
