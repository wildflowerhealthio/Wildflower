import { type SeriesKey, parseSeriesId, seriesId } from './series.ts'
import { type RangePreset, isRangePreset } from './time-range.ts'

/** Everything the viewer's URL carries: what is plotted, over what window, for whom. */
interface Selection {
  /** The plotted series, in selection order — the order that decides axis sides. */
  readonly series: readonly SeriesKey[]
  readonly range: RangePreset
  /** The patient whose record is open, or `null` for the signed-in patient's own. */
  readonly patient: string | null
}

/** Query key repeated once per selected series. */
const SERIES_PARAM = 's'

/** Query key holding the {@link RangePreset}. */
const RANGE_PARAM = 'r'

/** Query key holding the patient id. */
const PATIENT_PARAM = 'patient'

/** The preset a selection falls back to when the URL names none or names a bad one. */
const DEFAULT_RANGE: RangePreset = 'all'

/**
 * Render a selection as query parameters.
 *
 * @returns Params carrying one `s` per series in order, one `r`, and a
 *   `patient` only when one is set
 *
 * @remarks
 * A `null` patient is an absent key rather than an empty value, so the
 * shortest URL is the common case. {@link decodeSelection} inverts this
 * exactly.
 */
const encodeSelection = (selection: Selection): URLSearchParams => {
  const params = new URLSearchParams()
  for (const key of selection.series) params.append(SERIES_PARAM, seriesId(key))
  params.set(RANGE_PARAM, selection.range)
  if (selection.patient !== null) params.set(PATIENT_PARAM, selection.patient)
  return params
}

/**
 * Read a selection back out of query parameters.
 *
 * @returns The selection; never throws
 *
 * @remarks
 * Everything unrecognised is dropped, not rejected: a URL is user-editable and
 * outlives the series it names, so an `s` that no longer parses, or an `r`
 * that is not a preset, must not cost the reader the rest of their link. An
 * absent `r` means {@link DEFAULT_RANGE}.
 */
const decodeSelection = (params: URLSearchParams): Selection => {
  const series = params
    .getAll(SERIES_PARAM)
    .map(parseSeriesId)
    .filter((key): key is SeriesKey => key !== null)
  const range = params.get(RANGE_PARAM)
  return {
    series,
    range: range !== null && isRangePreset(range) ? range : DEFAULT_RANGE,
    patient: params.get(PATIENT_PARAM),
  }
}

export type { Selection }
export { DEFAULT_RANGE, PATIENT_PARAM, RANGE_PARAM, SERIES_PARAM, decodeSelection, encodeSelection }
