/**
 * Display labels for scopes — the human-readable half of the picker. FHIR and
 * Wildflower resource types map strictly 1:1 to a label that names the *whole*
 * resource; flag scopes map to plain-language consent copy (`spec.md §7`). A
 * view-model concern (display copy) with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { Labels } from 'scopes-core'`).
 */

import type { KnownScope } from '../domain/index.ts'
import type * as Bucket from './bucket.ts'

/** A resource's singular and plural display names. */
export type Resource = { readonly label: string; readonly plural: string }

/** Strict 1:1 FHIR `ResourceType` → display name. Extend as resources surface. */
export const FHIR: Readonly<Record<string, Resource>> = {
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

/** Strict 1:1 Wildflower admin `Resource` → display name. */
export const WILDFLOWER: Readonly<Record<string, Resource>> = {
  AuthorizationRequest: { label: 'Authorization request', plural: 'Authorization requests' },
  Grant: { label: 'Grant', plural: 'Grants' },
  Client: { label: 'Connected app', plural: 'Connected apps' },
  RefreshToken: { label: 'Refresh token', plural: 'Refresh tokens' },
}

/** Plain-language consent copy for each flag scope (`spec.md §7`). */
export const FLAG: Readonly<Record<KnownScope.KnownScope, string>> = {
  openid: 'Confirm who you are',
  profile: 'Your basic profile details',
  fhirUser: 'Link to your patient record',
  offline_access: 'Stay connected in the background',
  launch: 'Know how the app was launched',
  'launch/patient': 'Open a specific patient',
}

/** The label shown for the live wildcard row (`spec.md §4`). */
export const WILDCARD = '✶ All record types'

/** The required "current and future" note shown wherever a wildcard is selectable (`spec.md §4`). */
export const WILDCARD_NOTE = 'Covers all current and future record types.'

/** The 1:1 display label for a resource name in a bucket (`*` → the wildcard label). */
export const resource = (bucket: Bucket.Bucket, name: string): string => {
  if (name === '*') return WILDCARD
  if (bucket.kind === 'wildflower') return WILDFLOWER[name]?.label ?? name
  return FHIR[name]?.label ?? name
}

/** The plural display label for a resource name in a bucket. */
export const plural = (bucket: Bucket.Bucket, name: string): string => {
  if (name === '*') return WILDCARD
  if (bucket.kind === 'wildflower') return WILDFLOWER[name]?.plural ?? name
  return FHIR[name]?.plural ?? name
}
