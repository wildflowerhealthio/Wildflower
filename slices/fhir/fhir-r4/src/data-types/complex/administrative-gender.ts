import { Schema } from 'effect'

/**
 * The gender of a person used for administrative purposes.
 *
 * This value set is used across multiple FHIR resources including:
 * - Patient
 * - Practitioner
 * - Person
 * - RelatedPerson
 *
 * @see https://www.hl7.org/fhir/valueset-administrative-gender.html
 */
export const AdministrativeGender = Schema.Enums({
  female: 'female',
  male: 'male',
  other: 'other',
  unknown: 'unknown',
} as const)
export type AdministrativeGender = typeof AdministrativeGender.Type
