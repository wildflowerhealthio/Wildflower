import { dedupeMedicationsByName, type Medication } from 'medication-sponsorship-core'
import type { MedicationView } from 'medication-sponsorship-react'

/**
 * The completed prescriptions worth showing on the savings page: every
 * `completed` medication, de-duplicated by name, with any that a current
 * `active` prescription already covers removed — the active row stands in for
 * the past one, so listing both would be redundant. The result is what the
 * savings view renders (dimmed) beneath its active eligibility rows.
 *
 * @param views - Every loaded medication view, of any status.
 * @returns The past-but-still-relevant medications, one per distinct name.
 */
export const pastEligibleMedications = (
  views: readonly MedicationView[]
): readonly Medication[] => {
  const activeNames = new Set(
    views.flatMap((view) =>
      view.medication.status === 'active' ? [view.medication.displayName] : []
    )
  )
  const completed = views.flatMap((view) =>
    view.medication.status === 'completed' ? [view.medication] : []
  )
  return dedupeMedicationsByName(completed).filter(
    (medication) => !activeNames.has(medication.displayName)
  )
}
