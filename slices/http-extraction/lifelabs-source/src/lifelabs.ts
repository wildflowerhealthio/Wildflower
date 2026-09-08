/**
 * Constants for the LifeLabs MyCareCompass portal
 * (`mycarecompass.lifelabs.com`): the FHIR identifier and coding systems this
 * source stamps onto the resources it synthesizes from the portal's bespoke
 * (non-FHIR) `GetAnalyticSummary` JSON.
 *
 * @remarks
 * These system URIs are best-guess namespaces under the portal host, *not*
 * captured from a canonical registry. LifeLabs publishes no OID for its
 * internal test codes (`testCode`, e.g. `TR10477-8W`), so
 * {@link LIFELABS_TEST_SYSTEM} is a namespaced placeholder — `code.text` (the
 * human-readable analyte name) is the load-bearing field and the coding is
 * supplementary. Reconcile against a real system URL if one is confirmed.
 */

/** Base URL every LifeLabs identifier/coding system is built from. */
const SYSTEM_BASE = 'https://mycarecompass.lifelabs.com/fhir'

/** LifeLabs identifier systems for the ids the portal JSON carries. */
const LifeLabsIdentifierSystem = {
  /**
   * The portal's numeric patient id (`entity.selectedPatient`, also each
   * `entity.patients[].value`) — the id every synthesized Observation's
   * `subject` references.
   */
  PatientId: `${SYSTEM_BASE}/identifier/patient-id`,
} as const

/** The coding system for LifeLabs' internal test codes (`analytics[].testCode`). */
const LIFELABS_TEST_SYSTEM = `${SYSTEM_BASE}/test-code`

/**
 * LOINC, the one standard system this source can stamp: each `testItemId` is
 * base64 of `<testCode>__<loinc>;` (a real capture shows `TR10477-8W__6690-2;`
 * for WBC, `TR10397-8H__2951-2;` for Sodium), so the analyte's LOINC code is
 * recoverable without a lookup table.
 */
const LOINC_SYSTEM = 'http://loinc.org'

export { LifeLabsIdentifierSystem, LIFELABS_TEST_SYSTEM, LOINC_SYSTEM }
