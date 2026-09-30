/**
 * The Pebble "App Configuration (Static)" contract, generic over what the
 * settings are: where a watchapp's settings page may hand them back to, how
 * that return address survives a sign-in, and, for the watchapp's PebbleKit JS,
 * how the page's response decodes.
 *
 * Every module is a namespace, imported as `* as Name` inside the package and
 * re-exported under that name here:
 *
 * - {@link ReturnTarget} — the allow-listed Pebble `return_to` and the hand-off
 *   URL that carries the settings back to the phone app.
 * - {@link ReturnTargetStore} — keeps `return_to` across a sign-in, over any
 *   Web Storage–shaped store the app hands it.
 * - {@link decodeWebviewResponse} — the PebbleKit JS half, also exported alone,
 *   free of Effect, as `pebble-configuration/pkjs`.
 *
 * @packageDocumentation
 */
export { decodeWebviewResponse } from './pkjs.ts'
export * as ReturnTarget from './return-target.ts'
export * as ReturnTargetStore from './return-target-store.ts'
