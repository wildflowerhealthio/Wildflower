import { SeriesId } from '@wildflowerhealthio/plots-fundamentals'

/**
 * Identity of an observation point series: its code, that code's system, and
 * the unit its values are in.
 *
 * @remarks
 * `unit` is identity, not metadata — one code in two units is two series, so
 * an axis never silently mixes scales. `system` is `null` when the key fell
 * back to the concept's `text`.
 */
interface ObservationPointSeriesKey {
  readonly kind: 'points'
  readonly system: string | null
  readonly code: string
  readonly unit: string | null
}

/**
 * Identity of an observation span series: the code its coded-value,
 * period-dated observations share, and that code's system. A span has no
 * value to carry a unit; the coded value tells one span from another inside
 * the series, so it is not part of the key.
 */
interface ObservationSpanSeriesKey {
  readonly kind: 'spans'
  readonly system: string | null
  readonly code: string
}

/** Identity of an observation series; discriminate on `kind`, as on the series. */
type ObservationSeriesKey = ObservationPointSeriesKey | ObservationSpanSeriesKey

/** The prefix every observation series id starts with: `o:<system>|<code>|<unit>`. */
const OBSERVATION_ID_PREFIX = 'o'

/** The fourth field that marks a span series id, after a `null` unit. */
const SPAN_MARKER = 'span'

/**
 * The stable string form of an observation series key — safe as a URL value,
 * React key or catalogue row id: `o:<system>|<code>|<unit>` for a point
 * series, and `o:<system>|<code>|\~|span` (a `null` unit, then the span
 * marker) for a span series.
 *
 * @remarks
 * External contract: this is what a shared link carries, so changing the
 * field order, the marker or the escaping invalidates every link already
 * saved. The field count tells the two forms apart.
 */
const observationSeriesIdOf = (key: ObservationSeriesKey): string =>
  SeriesId.fromFields(
    OBSERVATION_ID_PREFIX,
    key.kind === 'points'
      ? [key.system, key.code, key.unit]
      : [key.system, key.code, null, SPAN_MARKER]
  )

/**
 * Parse the string form {@link observationSeriesIdOf} produces. Never throws —
 * ids arrive from a user-editable URL, so a bad one is dropped, not raised.
 *
 * @returns `null` for another prefix, a field count other than 3 or 4, a
 *   fourth field that is not the span marker after a `null` unit, any spelling
 *   {@link observationSeriesIdOf} would not write, or a null marker in the
 *   never-nullable `code` slot
 */
const parseObservationSeriesId = (id: string): ObservationSeriesKey | null => {
  const fields = SeriesId.toFields(OBSERVATION_ID_PREFIX, id)
  if (fields === null) return null
  if (fields.length === 3) {
    const [system, code, unit] = fields
    return code === null ? null : { kind: 'points', system, code, unit }
  }
  if (fields.length === 4) {
    const [system, code, unit, marker] = fields
    return code === null || unit !== null || marker !== SPAN_MARKER
      ? null
      : { kind: 'spans', system, code }
  }
  return null
}

export { OBSERVATION_ID_PREFIX, observationSeriesIdOf, parseObservationSeriesId }
export type { ObservationPointSeriesKey, ObservationSeriesKey, ObservationSpanSeriesKey }
