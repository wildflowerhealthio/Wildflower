import { Either, Encoding } from 'effect'

import { LIFELABS_TEST_SYSTEM, LOINC_SYSTEM } from '../lifelabs.ts'
import { LOINC_UNITS, UCUM_SYSTEM, ucumCodeFor } from '../units.ts'

/**
 * What the two analytic-bearing LifeLabs payloads share: `GetAnalyticSummary`
 * (every analyte, latest values, **no unit**) and `ViewAnalytics` (one analyte's
 * history, **with** `testUnit`). Both mint their `Observation`s through these
 * helpers so the same draw of the same analyte gets the same logical id
 * whichever payload it arrives in — the unit-bearing row then simply supersedes
 * the unitless one on persist.
 */

/**
 * FHIR logical ids allow only `[A-Za-z0-9-.]{1,64}`, but `testItemId` is
 * base64 (carrying `+`, `/`, `=`). Map to a safe token: `+`→`-`, `/`→`.` (both
 * in the FHIR alphabet), strip `=` padding (deterministic from length, so no
 * collision), and replace anything else with `-`.
 */
const toFhirIdToken = (raw: string): string =>
  raw
    .replace(/\+/g, '-')
    .replace(/\//g, '.')
    .replace(/=+$/g, '')
    .replace(/[^A-Za-z0-9.-]/g, '-')

/**
 * The largest epoch-millis value `Date` represents (ECMA-262's time-value
 * range). Past it `toISOString()` throws a `RangeError` — a *defect* inside
 * `parse`, and a defect escapes `Extraction.parseWith`'s fold and takes the
 * whole extraction run down. Bounded here, where an out-of-range token is
 * merely an unusable date.
 */
const MAX_TIME_VALUE = 8_640_000_000_000_000

/**
 * Absolute epoch millis from a collection instant, or `undefined` if
 * unparseable or outside the representable date range. Accepts both a .NET
 * `/Date(1779297900000-0400)/` token (the trailing `±hhmm` is a display-only
 * original offset; the millis are already absolute UTC) and an ISO 8601
 * string (`2023-02-15T13:55:34+00:00`, or offset-less `2016-07-10T18:25:29`,
 * read as UTC) — the portal's sibling report endpoints serialize dates as ISO,
 * so the analytic payload is not assumed to differ.
 */
const collectionMillis = (raw: string | null | undefined): number | undefined => {
  if (raw == null) return undefined
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(raw)
  const millis = m === null ? Date.parse(isoAsUtc(raw)) : Number(m[1])
  return Number.isFinite(millis) && Math.abs(millis) <= MAX_TIME_VALUE ? millis : undefined
}

/**
 * Pin an offset-less ISO date-time to UTC so `Date.parse` doesn't read it in
 * the host's local zone. Leaves anything already carrying `Z` / `±hh:mm` alone.
 */
const isoAsUtc = (raw: string): string =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? `${raw}Z` : raw

/**
 * `4.0 - 11.0` / `120- 160` / `0.350 - 0.450` → numeric `{ low, high }`; a
 * one-sided `<2.6` / `<=2.6` → `{ high }` and `>40` / `>=40` → `{ low }`; a
 * range that is none of these yields `{}` (the raw string is still kept as
 * `referenceRange[].text`).
 */
const parseReferenceRange = (raw: string): { low?: number; high?: number } => {
  const out: { low?: number; high?: number } = {}
  const interval = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(raw)
  if (interval !== null) {
    const low = Number(interval[1])
    const high = Number(interval[2])
    if (Number.isFinite(low)) out.low = low
    if (Number.isFinite(high)) out.high = high
    return out
  }
  const oneSided = /^\s*([<>])=?\s*([\d.]+)\s*$/.exec(raw)
  if (oneSided !== null) {
    const bound = Number(oneSided[2])
    if (Number.isFinite(bound)) {
      if (oneSided[1] === '<') out.high = bound
      else out.low = bound
    }
  }
  return out
}

/**
 * The LOINC code a `testItemId` embeds: the id is base64 of
 * `<testCode>__<loinc>;` (`TR10477-8W__6690-2;` is WBC). `undefined` for an id
 * that is not base64, or whose plaintext is not that shape — the LifeLabs
 * coding still carries the analyte, this one is a bonus.
 */
const loincFromTestItemId = (testItemId: string): string | undefined => {
  const decoded = Encoding.decodeBase64String(testItemId)
  if (Either.isLeft(decoded)) return undefined
  const m = /^[^_]+__(\d{1,5}-\d);?$/.exec(decoded.right)
  return m?.[1]
}

/** FHIR logical ids are at most 64 characters. */
const MAX_FHIR_ID_LENGTH = 64

/**
 * A stable, FHIR-safe logical id for one draw of one analyte: the sanitized
 * key (normally the base64 `testItemId`, unique per analyte) suffixed with the
 * collection instant, so repeat draws across dates don't collide. Truncation
 * keeps the instant suffix rather than an over-long token's tail, which would
 * re-collide the analyte across dates.
 */
const analyteObservationId = (key: string, collectionDate: string | null | undefined): string => {
  const token = toFhirIdToken(key)
  const millis = collectionMillis(collectionDate)
  if (millis == null) return token.slice(0, MAX_FHIR_ID_LENGTH)
  const suffix = `-${millis}`
  return `${token.slice(0, MAX_FHIR_ID_LENGTH - suffix.length)}${suffix}`
}

/**
 * The LifeLabs test-request code a `testItemId` embeds (`TR10477-8W` from
 * `TR10477-8W__6690-2;`), for a payload that carries the id but not the code.
 */
const testCodeFromTestItemId = (testItemId: string): string | undefined => {
  const decoded = Encoding.decodeBase64String(testItemId)
  if (Either.isLeft(decoded)) return undefined
  const m = /^([^_]+)__\d{1,5}-\d;?$/.exec(decoded.right)
  return m?.[1]
}

/** The analyte identity an Observation's `code` is built from. */
interface AnalyteCode {
  readonly testItemId?: string | null | undefined
  readonly testItemName?: string | null | undefined
  readonly testName?: string | null | undefined
  readonly testCode?: string | null | undefined
}

/**
 * The `code` wire for an analyte: `text` is the analyte name, with a LOINC
 * coding (recovered from `testItemId`) first and LifeLabs' own panel coding
 * second; either is omitted when its source field is missing.
 */
const analyteCodeWire = (a: AnalyteCode): Record<string, unknown> => {
  const codeText = a.testItemName ?? a.testName ?? a.testCode ?? 'Unknown'
  const code: Record<string, unknown> = { text: codeText }
  const coding: Record<string, unknown>[] = []
  const loinc = a.testItemId == null ? undefined : loincFromTestItemId(a.testItemId)
  if (loinc !== undefined) {
    coding.push({
      system: LOINC_SYSTEM,
      code: loinc,
      ...(a.testItemName != null && a.testItemName.length > 0 ? { display: a.testItemName } : {}),
    })
  }
  if (a.testCode != null && a.testCode.length > 0) {
    coding.push({
      system: LIFELABS_TEST_SYSTEM,
      code: a.testCode,
      ...(a.testName != null && a.testName.length > 0 ? { display: a.testName } : {}),
    })
  }
  if (coding.length > 0) code['coding'] = coding
  return code
}

/**
 * The `valueQuantity` wire for a numeric result. The unit is the payload's own
 * when it carries one (`ViewAnalytics`' `testUnit`), else the researched
 * LifeLabs unit for the analyte's LOINC (`GetAnalyticSummary` carries none);
 * a unit whose UCUM code is known gets `system` + `code` too. `undefined` when
 * the raw value is not a finite number — the caller falls back to `valueString`.
 */
const quantityWire = (
  rawValue: string,
  payloadUnit: string | null | undefined,
  loinc: string | undefined
): Record<string, unknown> | undefined => {
  const value = Number(rawValue)
  if (!Number.isFinite(value)) return undefined
  const unit =
    payloadUnit != null && payloadUnit.trim().length > 0
      ? payloadUnit.trim()
      : loinc === undefined
        ? undefined
        : LOINC_UNITS[loinc]
  if (unit === undefined) return { value }
  const ucum = ucumCodeFor(unit)
  return ucum === undefined ? { value, unit } : { value, unit, system: UCUM_SYSTEM, code: ucum }
}

/** The `referenceRange` wire for a raw range string, or `undefined` for a blank one. */
const referenceRangeWire = (
  raw: string | null | undefined
): Record<string, unknown> | undefined => {
  if (raw == null || raw.trim().length === 0) return undefined
  const { low, high } = parseReferenceRange(raw)
  const range: Record<string, unknown> = { text: raw }
  if (low != null) range['low'] = { value: low }
  if (high != null) range['high'] = { value: high }
  return range
}

export {
  analyteCodeWire,
  analyteObservationId,
  collectionMillis,
  loincFromTestItemId,
  parseReferenceRange,
  quantityWire,
  referenceRangeWire,
  testCodeFromTestItemId,
  toFhirIdToken,
}
