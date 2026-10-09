/**
 * The pure core of FHIR Sync for Pebble, with no DOM and no platform imports:
 * what the watchapp's settings page decides — the patients it offers and the
 * settings the watch receives — and what the watchapp's PebbleKit JS does with
 * what the watch sends it. Where the page may hand the settings back to, and
 * how that return address survives the SMART login, are `pebble-configuration`'s.
 *
 * Every module is a namespace, imported as `* as Name` inside the package and
 * re-exported under that name here:
 *
 * - {@link PatientSummary} — the patients a `Patient` search lists, read
 *   leniently so one unusual record does not empty the list.
 * - {@link PebbleSettings} — the watch's wire shape, built from the SMART grant
 *   (`fromGrant`) and the patient the user picks (`withPatient`).
 * - {@link HealthActivity}, {@link MinuteHistory}, {@link PhoneSettings},
 *   {@link WatchDevice} and {@link WatchSync} — the PebbleKit JS half, also
 *   exported alone, free of Effect, as `fhir-sync-pebble-core-js/pkjs`.
 *
 * @packageDocumentation
 */
export * as PatientSummary from './patient-summary.ts'
export * as PebbleSettings from './pebble-settings.ts'
export { HealthActivity, MinuteHistory, PhoneSettings, WatchDevice, WatchSync } from './pkjs.ts'
