/**
 * The part of FHIR Sync for Pebble's core the watchapp's PebbleKit JS runs:
 * decoding what the watch and the settings page send the phone, and the FHIR
 * Observations a sync posts.
 *
 * @remarks
 * Its own entry point because the phone's JavaScript runtime is ES5: nothing
 * reachable from here may import Effect, `fhir-r4` or any other module that
 * needs ES2015 at run time, or use an ES2015 library method. Its modules import
 * nothing from the rest of the package, not even types, which keeps the
 * watchapp's type-check against ES5's library small. That build
 * (`apps/fhir-sync-pebble/fhir-sync-pebble-watchapp/pkjs`) lowers the syntax to ES5 and fails on an
 * ES2015 method or global.
 *
 * - {@link HealthActivity} — an activity message in, its Observation out.
 * - {@link MinuteHistory} — an hour of minute history in, an Observation per
 *   minute type out.
 * - {@link PhoneSettings} — the settings the phone keeps, and the watch's part.
 * - {@link WatchDevice} — the watch as the Observations' `device`, and the id
 *   each Observation is written under.
 * - {@link WatchSync} — a whole sync: its messages collected from its start and
 *   checked, its transaction Bundle, and the answer to the watch.
 *
 * @packageDocumentation
 */
export * as HealthActivity from './health-activity.ts'
export * as MinuteHistory from './minute-history.ts'
export * as PhoneSettings from './phone-settings.ts'
export * as WatchDevice from './watch-device.ts'
export * as WatchSync from './watch-sync.ts'
