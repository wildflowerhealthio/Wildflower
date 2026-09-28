import { ValueAxis } from 'health-viewer-fundamentals'

import { isKnownSeriesId } from './series-sources.ts'
import { type RangePreset, isRangePreset } from './time-range.ts'

/** Everything the viewer's URL carries: what is plotted, over what window, for whom. */
interface Selection {
  /**
   * The plotted series' ids, in selection order — the order that decides axis
   * sides. Distinct, and at most `ValueAxis.CAP` of them. Opaque here: each id
   * belongs to the source whose prefix it carries.
   */
  readonly series: readonly string[]
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
 * Render a selection as query parameters — one `s` per series in order, one
 * `r`, and a `patient` only when set, so the shortest URL is the common case.
 */
const encodeSelection = (selection: Selection): URLSearchParams => {
  const params = new URLSearchParams()
  for (const id of selection.series) params.append(SERIES_PARAM, id)
  params.set(RANGE_PARAM, selection.range)
  if (selection.patient !== null) params.set(PATIENT_PARAM, selection.patient)
  return params
}

/**
 * Read a selection back out of query parameters. Never throws.
 *
 * @remarks
 * Everything unrecognised is dropped, not rejected: a URL is user-editable and
 * outlives the series it names, so one stale `s` must not cost the reader the
 * rest of their link. An `s` survives when some source can read it
 * (`isKnownSeriesId`) — so an id whose source the viewer does not assemble,
 * or that its source would not have written, is dropped.
 * A repeated `s` keeps its first place, and only the first `ValueAxis.CAP`
 * survivors are kept — the chart draws no more, and `ValueAxis.assign` throws
 * past the cap rather than truncating, so a hand-edited link is cut here.
 * An absent or bad `r` means {@link DEFAULT_RANGE}.
 */
const decodeSelection = (params: URLSearchParams): Selection => {
  const series = [...new Set(params.getAll(SERIES_PARAM).filter(isKnownSeriesId))].slice(
    0,
    ValueAxis.CAP
  )
  const range = params.get(RANGE_PARAM)
  return {
    series,
    range: range !== null && isRangePreset(range) ? range : DEFAULT_RANGE,
    patient: params.get(PATIENT_PARAM),
  }
}

export type { Selection }
export { DEFAULT_RANGE, PATIENT_PARAM, RANGE_PARAM, SERIES_PARAM, decodeSelection, encodeSelection }
