import type { DateTime } from 'effect'

/**
 * Identity of an observation-backed series: its code, that code's system, and
 * the unit its values are in.
 *
 * @remarks
 * `unit` is identity, not metadata — one code in two units is two series, so
 * an axis never silently mixes scales. `system` is `null` when the key fell
 * back to the concept's `text`.
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
 * One plotted reading, optionally bracketed by the reference range that
 * applied. `low` / `high` are absent rather than `null` when there was none.
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
 * One interval over which a single dose was in effect. Defined here, not
 * beside the dose-regimen mapping that builds it, so the mapping only has to
 * produce the shape.
 *
 * @remarks
 * `end` is `null` while open, `perDay` tells a daily total from a per-take
 * dose, and `dashed` marks an extent that is inferred rather than stated.
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
 * The marker standing in for a `null` field. Unambiguous because
 * {@link escapeField} doubles every backslash, so no escaped field can render
 * as a lone backslash followed by `~`.
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
 * @returns The still-escaped fields, or `null` on a dangling escape — which no
 *   {@link escapeField} output can end in
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

/** Reverse {@link renderField}; the null marker reads back as `null`. */
const parseField = (field: string): string | null =>
  field === NULL_FIELD ? null : field.replaceAll('\\|', FIELD_SEPARATOR).replaceAll('\\\\', '\\')

/**
 * The stable string form of a series key — `o:<system>|<code>|<unit>` or
 * `m:<name>|<unit>` — safe as a URL value, React key or catalogue row id.
 *
 * @remarks
 * External contract: this is what a shared link carries, so changing the
 * escaping invalidates every link already saved.
 */
const seriesId = (key: SeriesKey): string =>
  key.kind === 'observation'
    ? `o:${renderField(key.system)}${FIELD_SEPARATOR}${escapeField(key.code)}${FIELD_SEPARATOR}${renderField(key.unit)}`
    : `m:${escapeField(key.name)}${FIELD_SEPARATOR}${renderField(key.unit)}`

/**
 * Parse the string form {@link seriesId} produces. Never throws — ids arrive
 * from a user-editable URL, so a bad one is dropped, not raised.
 *
 * @returns `null` for an unknown prefix, the wrong field count, a dangling
 *   escape, or a null marker in the never-nullable `code` / `name` slot
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
