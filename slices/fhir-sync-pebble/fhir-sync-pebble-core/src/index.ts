/**
 * The pure core of FHIR Sync for Pebble: what the watchapp's settings page
 * decides, with no DOM and no platform imports — the patients it offers, the
 * settings the watch receives, where the page may hand them back to, and how
 * that return address survives the SMART login.
 *
 * Every module is a namespace, imported as `* as Name` inside the package and
 * re-exported under that name here:
 *
 * - {@link PatientSummary} — the patients a `Patient` search lists, read
 *   leniently so one unusual record does not empty the list.
 * - {@link PebbleSettings} — the watch's wire shape, built from the SMART grant
 *   (`fromGrant`) and the patient the user picks (`withPatient`).
 * - {@link ReturnTarget} — the allow-listed Pebble `return_to` and the hand-off
 *   URL that carries the settings back to the phone app.
 * - {@link ReturnTargetStore} — keeps `return_to` across the login, over any
 *   Web Storage–shaped store the app hands it.
 *
 * @packageDocumentation
 */
export * as PatientSummary from './patient-summary.ts'
export * as PebbleSettings from './pebble-settings.ts'
export * as ReturnTarget from './return-target.ts'
export * as ReturnTargetStore from './return-target-store.ts'
