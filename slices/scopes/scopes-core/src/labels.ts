/**
 * Display labels for scopes — the human-readable half of the picker. FHIR and
 * Wildflower resource types map strictly 1:1 to a label that names the *whole*
 * resource (never a sub-concept like "Observation = heart rate"); flag scopes
 * map to plain-language consent copy (`spec.md §7`). Resources missing from a
 * map fall back to the raw type so nothing is unnameable.
 */

import type { Context, FlagScope } from './model.ts'

/** A resource's singular and plural display names. */
export interface ResourceLabel {
  readonly label: string
  readonly plural: string
}

/** Strict 1:1 FHIR `ResourceType` → display name. Extend as resources surface. */
export const FHIR_LABELS: Readonly<Record<string, ResourceLabel>> = {
  Observation: { label: 'Observation', plural: 'Observations' },
  MedicationRequest: { label: 'Medication request', plural: 'Medication requests' },
  Appointment: { label: 'Appointment', plural: 'Appointments' },
  Condition: { label: 'Condition', plural: 'Conditions' },
  AllergyIntolerance: { label: 'Allergy', plural: 'Allergies' },
  Immunization: { label: 'Immunization', plural: 'Immunizations' },
  Procedure: { label: 'Procedure', plural: 'Procedures' },
  DiagnosticReport: { label: 'Diagnostic report', plural: 'Diagnostic reports' },
  DocumentReference: { label: 'Document', plural: 'Documents' },
  Encounter: { label: 'Encounter', plural: 'Encounters' },
  CarePlan: { label: 'Care plan', plural: 'Care plans' },
  Goal: { label: 'Goal', plural: 'Goals' },
  MedicationStatement: { label: 'Medication statement', plural: 'Medication statements' },
  Patient: { label: 'Patient demographics', plural: 'Patient demographics' },
}

/** Strict 1:1 Wildflower admin `Resource` → display name (Rust's `WildflowerResource`). */
export const WILDFLOWER_LABELS: Readonly<Record<string, ResourceLabel>> = {
  AuthorizationRequest: { label: 'Authorization request', plural: 'Authorization requests' },
  Grant: { label: 'Grant', plural: 'Grants' },
  Client: { label: 'Connected app', plural: 'Connected apps' },
  RefreshToken: { label: 'Refresh token', plural: 'Refresh tokens' },
}

/** Plain-language consent copy for each flag scope (`spec.md §7`). */
export const FLAG_COPY: Readonly<Record<FlagScope, string>> = {
  openid: 'Confirm who you are',
  profile: 'Your basic profile details',
  fhirUser: 'Link to your patient record',
  offline_access: 'Stay connected in the background',
  launch: 'Know how the app was launched',
  'launch/patient': 'Open a specific patient',
}

/** The label shown for the live wildcard row (`spec.md §4`). */
export const WILDCARD_LABEL = '✶ All record types'

/** The required "current and future" note shown wherever a wildcard is selectable (`spec.md §4`). */
export const WILDCARD_NOTE = 'Covers all current and future record types.'

/**
 * The 1:1 display label for a resource in a context. `'*'` → the wildcard label;
 * Wildflower resources use the admin map; everything else uses the FHIR map and
 * falls back to the raw type if absent.
 */
export const resourceLabel = (context: Context, resource: string): string => {
  if (resource === '*') return WILDCARD_LABEL
  if (context === 'wildflower') return WILDFLOWER_LABELS[resource]?.label ?? resource
  return FHIR_LABELS[resource]?.label ?? resource
}

/** The plural display label for a resource in a context (column/list headings). */
export const resourcePlural = (context: Context, resource: string): string => {
  if (resource === '*') return WILDCARD_LABEL
  if (context === 'wildflower') return WILDFLOWER_LABELS[resource]?.plural ?? resource
  return FHIR_LABELS[resource]?.plural ?? resource
}
