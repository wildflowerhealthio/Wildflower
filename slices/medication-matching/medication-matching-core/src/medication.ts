/**
 * The minimal medication shape the medication slices match on. Adapters map a
 * FHIR `MedicationRequest` (or anything else) onto this so the pure cores stay
 * FHIR-agnostic and trivially testable.
 */
interface Medication {
  readonly id: string
  /** Best available human-readable medication name (used for matching). */
  readonly displayName: string
  /** FHIR `MedicationRequest.status`, if known. */
  readonly status?: string | undefined
  /** ISO date the request was authored, if known. */
  readonly authoredOn?: string | undefined
}

export type { Medication }
