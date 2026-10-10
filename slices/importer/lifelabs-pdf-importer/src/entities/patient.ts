import * as PageHeader from '../document/page-header.ts'

/**
 * The patient block at the top of every page — read off the page header by
 * label.
 *
 * @remarks
 * The fast-check `arbitrary` that lays a patient block out for tests lives in
 * the sibling `patient-arbitrary.ts` (test-only, so `fast-check` stays out of
 * the production bundle).
 *
 * @packageDocumentation
 */

/** The patient block at the top of every page. */
interface Type {
  /** The printed name, as `FAMILY, GIVEN GIVEN`. */
  readonly name: string
  /** The `Age:` value (`45 years`), or `''`. */
  readonly age: string
  /** The `Sex:` value (`F`, `M`), or `''`. */
  readonly sex: string
  /** The `Date of Birth:` value as printed (`Aug 13 1981`), or `''`. */
  readonly dateOfBirth: string
  /** The `HC #:` health card number as printed, version code included, or `''`. */
  readonly healthCardNumber: string
  /** The `Patient's Phone:` value, or `''`. */
  readonly phone: string
  /** The `Patient ID:` value, or `''`. */
  readonly patientId: string
}

/** Read the patient block off a page header. */
const fromPageHeader = (header: PageHeader.Type): Type => ({
  name: PageHeader.get(header, 'Patient:'),
  age: PageHeader.get(header, 'Age:'),
  sex: PageHeader.get(header, 'Sex:'),
  dateOfBirth: PageHeader.get(header, 'Date of Birth:'),
  healthCardNumber: PageHeader.get(header, 'HC #:'),
  phone: PageHeader.get(header, "Patient's Phone:"),
  patientId: PageHeader.get(header, 'Patient ID:'),
})

export { fromPageHeader }
export type { Type }
