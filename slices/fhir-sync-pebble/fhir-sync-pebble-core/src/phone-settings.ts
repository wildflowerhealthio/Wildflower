import { type Fields, isFields } from './fields.ts'
import { localResourceId } from './local-resource-id.ts'
import { truncateUtf8 } from './utf8.ts'

/**
 * The settings as the watchapp's PebbleKit JS holds them: decoded from the
 * settings page's `webviewclosed` response or from `localStorage`, and the
 * part of them the watch receives.
 *
 * @remarks
 * A namespace module — consumers speak `PhoneSettings.decodeResponse`,
 * `PhoneSettings.decodeStored`, `PhoneSettings.toWatchMessage`.
 *
 * {@link Settings} is the shape the settings page's `PebbleSettings.toJson`
 * writes: `PebbleSettings.Schema` is pinned to it. The decode is hand-written
 * rather than that Schema because PebbleKit JS bundles it and the phone's
 * runtime is ES5, which Effect does not run on; `phone-settings.test.ts`
 * round-trips generated settings through `toJson` and this decode to hold the
 * two together. This module imports nothing of `PebbleSettings`, not even its
 * types, so type-checking the phone's bundle never loads Effect.
 *
 * @packageDocumentation
 */

/**
 * Everything the watchapp's PebbleKit JS needs to sync the data the Pebble
 * collects to one patient's record as FHIR Observations, plus who that patient
 * is, so the watch can show it for confirmation on-device.
 */
interface Settings {
  /** The logical id of the patient the user picked. */
  readonly patientId: string
  /** The patient's display name, `fhir-r4`'s `HumanName.displayName`; `null` when the record has none. */
  readonly patientName: string | null
  /**
   * The patient's birth date as the server wrote it (`YYYY-MM-DD`, or a partial
   * `YYYY-MM` / `YYYY`); `null` when the record has none.
   */
  readonly patientBirthDate: string | null
  /** The SMART access token, sent as `Authorization: Bearer …`. */
  readonly accessToken: string
  /**
   * The FHIR base URL the token was granted for, without trailing slashes;
   * the sync's transaction Bundle is POSTed to it.
   */
  readonly fhirBaseUrl: string
}

/** The AppMessage dictionary the watch receives, keyed by `messageKeys` name. */
interface WatchMessage {
  /** At most {@link PATIENT_NAME_MAX_BYTES} bytes of UTF-8. */
  readonly PatientName: string
  /** At most {@link BIRTH_DATE_MAX_BYTES} bytes of UTF-8. */
  readonly PatientBirthDate: string
  /** Unix seconds. */
  readonly AuthTime: number
  /** Which patient on which server, as {@link connectionId} names them. */
  readonly ConnectionId: string
}

/**
 * The longest patient name, in UTF-8 bytes, the watch keeps: its
 * `PATIENT_NAME_SIZE` (src/c/state.h) less the NUL.
 */
const PATIENT_NAME_MAX_BYTES = 63

/**
 * The longest birth date, in UTF-8 bytes, the watch keeps: its
 * `BIRTH_DATE_SIZE` (src/c/state.h) less the NUL, a full `YYYY-MM-DD`.
 */
const BIRTH_DATE_MAX_BYTES = 10

const requireNonEmptyString = (settings: Fields, key: string): string => {
  const field = settings[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`Settings field ${key} must be a non-empty string`)
  }
  return field
}

const requireStringOrNull = (settings: Fields, key: string): string | null => {
  const field = settings[key]
  if (field !== null && typeof field !== 'string') {
    throw new Error(`Settings field ${key} must be a string or null`)
  }
  return field
}

/**
 * Decodes parsed settings JSON, keeping only the fields the settings carry.
 * Throws when the value is not that shape.
 */
const decodeSettings = (settings: unknown): Settings => {
  if (!isFields(settings) || Array.isArray(settings)) {
    throw new Error('Settings must be a JSON object')
  }
  return {
    patientId: requireNonEmptyString(settings, 'patientId'),
    patientName: requireStringOrNull(settings, 'patientName'),
    patientBirthDate: requireStringOrNull(settings, 'patientBirthDate'),
    accessToken: requireNonEmptyString(settings, 'accessToken'),
    fhirBaseUrl: requireNonEmptyString(settings, 'fhirBaseUrl'),
  }
}

/**
 * Decodes the settings page's `webviewclosed` response — the settings JSON,
 * URI-encoded. Throws when the response is not that shape.
 */
const decodeResponse = (response: string): Settings =>
  decodeSettings(JSON.parse(decodeURIComponent(response)))

/**
 * Decodes the settings `webviewclosed` last stored, or throws when the settings
 * page has never saved any.
 *
 * @param stored - What `localStorage.getItem` returns for them
 */
const decodeStored = (stored: string | null): Settings => {
  if (stored === null) {
    throw new Error('No settings stored; open the settings page first')
  }
  return decodeSettings(JSON.parse(stored))
}

/**
 * Which patient on which server `settings` connect to, as the watch compares
 * connections: `fhir-r4`'s `localResourceId` for the patient on the FHIR base
 * URL, `wf-` and 32 hex digits. The watch starts its last-sync times over when
 * it changes, and keeps them across a sign-in again to the same patient.
 */
const connectionId = (settings: Settings): string =>
  localResourceId(settings.fhirBaseUrl, 'Patient', settings.patientId)

/**
 * The AppMessage the watch shows the connection from: who the patient is,
 * when the settings arrived (`receivedAtMs`, as `Date.now()` reports it) and
 * the {@link connectionId}. The token and server stay on the phone. AppMessage
 * has no null, so a missing name or birth date is sent as the empty string,
 * which the watch reads as "none".
 *
 * The name and birth date are cut to what the watch keeps
 * ({@link PATIENT_NAME_MAX_BYTES}, {@link BIRTH_DATE_MAX_BYTES}) between code
 * points, so the watch neither cuts a character in half nor drops a message
 * too long for its inbox. At those lengths the message is at most 144 bytes of
 * the watch's 256-byte inbox: a count byte, then four tuples of a 7-byte header
 * and their values, 64 and 11 bytes for the name and birth date with their
 * NULs, 4 for the time and 36 for the connection id.
 */
const toWatchMessage = (settings: Settings, receivedAtMs: number): WatchMessage => ({
  PatientName: truncateUtf8(settings.patientName ?? '', PATIENT_NAME_MAX_BYTES),
  PatientBirthDate: truncateUtf8(settings.patientBirthDate ?? '', BIRTH_DATE_MAX_BYTES),
  AuthTime: Math.floor(receivedAtMs / 1000),
  ConnectionId: connectionId(settings),
})

export { connectionId, decodeResponse, decodeStored, toWatchMessage }
export type { Settings, WatchMessage }
