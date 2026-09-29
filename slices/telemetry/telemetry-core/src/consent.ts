import { Option, Schema } from 'effect'

/**
 * A visitor's answer to the telemetry consent dialog, as kept in the
 * browser's `localStorage`.
 *
 * @remarks
 * The two switches are independent opt-ins, both off until the visitor turns
 * them on: `crashReports` sends errors (which may carry data the app loaded),
 * `performance` sends anonymized page loads, request timings and route names.
 * `version` is the copy version of the dialog the visitor answered, so a
 * wording change re-asks; `decidedAt` is when they answered, as an ISO-8601
 * timestamp.
 */
const TelemetryConsent = Schema.Struct({
  version: Schema.Int,
  crashReports: Schema.Boolean,
  performance: Schema.Boolean,
  decidedAt: Schema.String,
})
type TelemetryConsent = typeof TelemetryConsent.Type

/**
 * The `localStorage` key the consent record is kept under. One key per origin,
 * so every app served from the same origin shares one answer.
 */
const CONSENT_STORAGE_KEY = 'wildflower.telemetry-consent'

/**
 * The Web Storage–shaped slice the consent record is kept in. Declared
 * structurally so this package names no DOM type: the app passes
 * `window.localStorage`, and a test a `Map`-backed stand-in.
 */
interface ConsentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const StoredTelemetryConsent = Schema.parseJson(TelemetryConsent)

const decodeStoredTelemetryConsent = Schema.decodeUnknownOption(StoredTelemetryConsent)

const encodeStoredTelemetryConsent = Schema.encodeSync(StoredTelemetryConsent)

/**
 * The visitor's answer to the current consent dialog, or `undefined` while
 * they have not given one.
 *
 * @param storage - Where the record is kept (`window.localStorage` in an app)
 * @param currentConsentVersion - The copy version of the dialog the app shows
 * @returns The stored consent when a record is present, decodes, and answers
 *   `currentConsentVersion`; `undefined` otherwise
 *
 * @remarks
 * A record that does not decode, or that answers another copy version, reads
 * as undecided rather than failing: the dialog asks again and its answer
 * replaces the record.
 */
const readConsent = (
  storage: ConsentStorage,
  currentConsentVersion: number
): TelemetryConsent | undefined =>
  Option.fromNullable(storage.getItem(CONSENT_STORAGE_KEY)).pipe(
    Option.flatMap(decodeStoredTelemetryConsent),
    Option.filter((storedConsent) => storedConsent.version === currentConsentVersion),
    Option.getOrUndefined
  )

/** Keep `consent` as the visitor's answer, replacing any earlier one. */
const writeConsent = (storage: ConsentStorage, consent: TelemetryConsent): void => {
  storage.setItem(CONSENT_STORAGE_KEY, encodeStoredTelemetryConsent(consent))
}

/** Forget the visitor's answer, so {@link readConsent} reads undecided. */
const clearConsent = (storage: ConsentStorage): void => {
  storage.removeItem(CONSENT_STORAGE_KEY)
}

export type { ConsentStorage }
export { clearConsent, CONSENT_STORAGE_KEY, readConsent, TelemetryConsent, writeConsent }
