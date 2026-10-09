/**
 * The pure core of WatchLifts' phone settings, with no DOM and no platform
 * imports: what the settings page edits — every person's weight at every
 * exercise — and what the watchapp's PebbleKit JS does with what the page
 * saves. Where the page may hand the settings back to is
 * `pebble-configuration`'s.
 *
 * Every module is a namespace, imported as `* as Name` inside the package and
 * re-exported under that name here:
 *
 * - {@link LiftSettings} — the weights as the page edits them, an Effect
 *   Schema, and their JSON.
 * - {@link Lifts} and {@link PhoneSettings} — the PebbleKit JS half, also
 *   exported alone, free of Effect, as `watch-lifts-core-js/pkjs`.
 *
 * @packageDocumentation
 */
export * as LiftSettings from './lift-settings.ts'
export { Lifts, PhoneSettings } from './pkjs.ts'
