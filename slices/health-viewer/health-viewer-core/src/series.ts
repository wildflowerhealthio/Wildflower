import type { DateTime } from 'effect'

/**
 * Identity of an observation-backed series: the code it plots, the coding
 * system that code belongs to, and the unit its values are in.
 *
 * @remarks
 * `unit` is part of the identity, not metadata: the same LOINC code reported
 * in `mmol/L` and in `mg/dL` is two series, because plotting them on one axis
 * would silently mix scales. `system` is `null` when the source
 * `CodeableConcept` carried no usable coding and the key fell back to its
 * `text`.
 */
interface ObservationSeriesKey {
  readonly kind: 'observation'
  readonly system: string | null
  readonly code: string
  readonly unit: string | null
}

/** Identity of a medication-backed series: the medication's name and dose unit. */
interface MedicationSeriesKey {
  readonly kind: 'medication'
  readonly name: string
  readonly unit: string | null
}

/** Identity of any plottable series — what a selection stores and the URL carries. */
type SeriesKey = ObservationSeriesKey | MedicationSeriesKey

/** What a series' numbers mean, which decides its axis domain and formatting. */
type SeriesKind = 'quantity' | 'integer' | 'boolean'

/**
 * One plotted reading: a value at an instant, optionally bracketed by the
 * reference range that applied to it.
 *
 * @remarks
 * `low` / `high` are absent (not `null`) when the source carried no reference
 * range, so a consumer spreads a point without inventing bounds.
 */
interface SeriesPoint {
  readonly time: DateTime.Utc
  readonly value: number
  readonly low?: number
  readonly high?: number
}

/** A plottable line of observation readings, sharing one code and one unit. */
interface ObservationSeries {
  readonly key: ObservationSeriesKey
  readonly label: string
  readonly unit: string | null
  /** The FHIR `Observation.category` code (`vital-signs`, `laboratory`, …), or `null`. */
  readonly category: string | null
  /** Sorted by `time`, ascending. */
  readonly points: readonly SeriesPoint[]
  readonly kind: SeriesKind
}

/**
 * One interval over which a single dose of a medication was in effect.
 *
 * @remarks
 * Defined here rather than alongside the dose-regimen mapping that builds it,
 * so the mapping only has to produce this shape. `end` is `null` for a segment
 * that is still open. `perDay` distinguishes a daily total from a per-take
 * dose, and `dashed` marks a segment whose extent is inferred rather than
 * stated, for a renderer to draw as a dashed run.
 */
interface DoseSegment {
  readonly start: DateTime.Utc
  readonly end: DateTime.Utc | null
  readonly dose: number
  readonly perDay: boolean
  readonly status: string
  readonly dashed: boolean
  readonly requestId: string
}

/** A plottable step line of dose segments for one medication. */
interface MedicationSeries {
  readonly key: MedicationSeriesKey
  readonly label: string
  readonly unit: string | null
  /** Sorted by `start`, ascending. */
  readonly segments: readonly DoseSegment[]
}

/** Either kind of plottable series; discriminate on `key.kind`. */
type Series = ObservationSeries | MedicationSeries

/** Whether `series` plots observation readings rather than dose segments. */
const isObservationSeries = (series: Series): series is ObservationSeries =>
  series.key.kind === 'observation'

/** Whether `series` plots dose segments rather than observation readings. */
const isMedicationSeries = (series: Series): series is MedicationSeries =>
  series.key.kind === 'medication'

/**
 * The marker standing in for a `null` field inside a series id.
 *
 * @remarks
 * {@link escapeField} doubles every backslash, so an escaped field can never
 * render as a lone backslash followed by `~`. That makes this marker
 * unambiguous against a field whose literal text is `\~`.
 */
const NULL_FIELD = '\\~'

/** The separator between a series id's fields, escaped inside each field. */
const FIELD_SEPARATOR = '|'

/** Escape `|` and `\` so a field can carry either without splitting the id. */
const escapeField = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll(FIELD_SEPARATOR, '\\|')

/** Render one field of a series id, mapping `null` to {@link NULL_FIELD}. */
const renderField = (value: string | null): string =>
  value === null ? NULL_FIELD : escapeField(value)

/**
 * Split an escaped field list on unescaped {@link FIELD_SEPARATOR}s.
 *
 * @returns The still-escaped fields, or `null` when the input ends in a
 *   dangling escape (`"a\\"`), which no {@link escapeField} output can be
 */
const splitFields = (body: string): readonly string[] | null => {
  const fields: string[] = []
  let current = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '\\') {
      if (index + 1 >= body.length) return null
      current += char + body[index + 1]
      index += 1
    } else if (char === FIELD_SEPARATOR) {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields
}

/**
 * Reverse {@link renderField} for one still-escaped field.
 *
 * @returns The field's text, or `null` when it is the null marker
 */
const parseField = (field: string): string | null =>
  field === NULL_FIELD ? null : field.replaceAll('\\|', FIELD_SEPARATOR).replaceAll('\\\\', '\\')

/**
 * The stable string form of a series key — `o:<system>|<code>|<unit>` for an
 * observation, `m:<name>|<unit>` for a medication.
 *
 * @returns An id safe to use as a URL query value, a React key, or a
 *   catalogue row id
 *
 * @remarks
 * This is the wire form the URL codec round-trips through, so it is part of
 * the viewer's external contract: changing the escaping invalidates every
 * shared link. {@link parseSeriesId} is its exact inverse.
 */
const seriesId = (key: SeriesKey): string =>
  key.kind === 'observation'
    ? `o:${renderField(key.system)}${FIELD_SEPARATOR}${escapeField(key.code)}${FIELD_SEPARATOR}${renderField(key.unit)}`
    : `m:${escapeField(key.name)}${FIELD_SEPARATOR}${renderField(key.unit)}`

/**
 * Parse the string form {@link seriesId} produces.
 *
 * @returns The key, or `null` for anything malformed — an unknown prefix, the
 *   wrong field count, a dangling escape, or a null marker in the `code` /
 *   `name` slot, which is never nullable
 *
 * @remarks
 * Never throws: ids reach this from a user-editable URL, so a bad one is
 * dropped rather than failing the whole selection.
 */
const parseSeriesId = (id: string): SeriesKey | null => {
  const prefix = id.slice(0, 2)
  if (prefix !== 'o:' && prefix !== 'm:') return null
  const fields = splitFields(id.slice(2))
  if (fields === null) return null

  if (prefix === 'o:') {
    if (fields.length !== 3) return null
    const code = parseField(fields[1])
    if (code === null) return null
    return { kind: 'observation', system: parseField(fields[0]), code, unit: parseField(fields[2]) }
  }

  if (fields.length !== 2) return null
  const name = parseField(fields[0])
  if (name === null) return null
  return { kind: 'medication', name, unit: parseField(fields[1]) }
}

export type {
  DoseSegment,
  MedicationSeries,
  MedicationSeriesKey,
  ObservationSeries,
  ObservationSeriesKey,
  Series,
  SeriesKey,
  SeriesKind,
  SeriesPoint,
}
export { isMedicationSeries, isObservationSeries, parseSeriesId, seriesId }
