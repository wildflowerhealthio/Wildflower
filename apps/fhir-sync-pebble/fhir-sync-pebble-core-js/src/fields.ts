/**
 * The fields of an object PebbleKit JS hands over untyped — an AppMessage
 * payload keyed by message key name, or `Pebble.getActiveWatchInfo()` — and
 * the checks the decoders read them through.
 *
 * @remarks
 * Internal to the package; the decoders that use it are what it exports. It is
 * hand-written rather than an Effect Schema because PebbleKit JS bundles it,
 * and the phone's runtime is ES5 (see `fhir-sync-pebble-core-js/pkjs`).
 *
 * @packageDocumentation
 */

/** An object's fields by name, not yet checked. */
interface Fields {
  readonly [key: string]: unknown
}

/** Whether `value` is an object whose fields can be read by name. */
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null

/** `payload`'s fields, AppMessage keys by name; throws when it isn't an object. */
const requirePayload = (payload: unknown): Fields => {
  if (!isFields(payload)) {
    throw new Error('Message payload must be an object')
  }
  return payload
}

/** `fields[key]` when it is an integer; throws naming `key` otherwise. */
const requireInteger = (fields: Fields, key: string): number => {
  const field = fields[key]
  if (typeof field !== 'number' || field % 1 !== 0) {
    throw new Error('Message field ' + key + ' must be an integer')
  }
  return field
}

export { isFields, requireInteger, requirePayload }
export type { Fields }
