import { SeriesId } from 'health-viewer-fundamentals'

/**
 * Identity of an observation series: its code, that code's system, and the
 * unit its values are in.
 *
 * @remarks
 * `unit` is identity, not metadata — one code in two units is two series, so
 * an axis never silently mixes scales. `system` is `null` when the key fell
 * back to the concept's `text`.
 */
interface ObservationSeriesKey {
  readonly system: string | null
  readonly code: string
  readonly unit: string | null
}

/** The prefix every observation series id starts with: `o:<system>|<code>|<unit>`. */
const OBSERVATION_ID_PREFIX = 'o'

/**
 * The stable string form of an observation series key,
 * `o:<system>|<code>|<unit>` — safe as a URL value, React key or catalogue
 * row id.
 *
 * @remarks
 * External contract: this is what a shared link carries, so changing the
 * field order or the escaping invalidates every link already saved.
 */
const observationSeriesIdOf = (key: ObservationSeriesKey): string =>
  SeriesId.fromFields(OBSERVATION_ID_PREFIX, [key.system, key.code, key.unit])

/**
 * Parse the string form {@link observationSeriesIdOf} produces. Never throws —
 * ids arrive from a user-editable URL, so a bad one is dropped, not raised.
 *
 * @returns `null` for another prefix, the wrong field count, any spelling
 *   {@link observationSeriesIdOf} would not write, or a null marker in the
 *   never-nullable `code` slot
 */
const parseObservationSeriesId = (id: string): ObservationSeriesKey | null => {
  const fields = SeriesId.toFields(OBSERVATION_ID_PREFIX, id)
  if (fields === null || fields.length !== 3) return null
  const [system, code, unit] = fields
  return code === null ? null : { system, code, unit }
}

export { OBSERVATION_ID_PREFIX, observationSeriesIdOf, parseObservationSeriesId }
export type { ObservationSeriesKey }
