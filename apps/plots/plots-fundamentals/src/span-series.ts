import type { DateTime } from 'effect'

/**
 * How many span lanes the chart draws at once.
 *
 * @remarks
 * A rendering limit, separate from `ValueAxis.CAP`: a span series takes a
 * thin lane under the time axis rather than a value axis, so it costs no
 * gutter, and two lanes are as many as sit under the figure without crowding
 * it. A selection UI caps against this constant.
 */
const LANE_CAP = 2

/**
 * How many fixed lane colours there are for a span's category to wear — the
 * `colourSlot` values a domain may pick, `0` to `COLOUR_SLOTS - 1`.
 */
const COLOUR_SLOTS = 5

/**
 * What a span is — the value that tells one span in a series from another.
 *
 * - `id`: opaque and stable, the one spans are grouped and keyed by.
 * - `label`: what the legend and the readout call it.
 * - `colourSlot`: which of the {@link COLOUR_SLOTS} lane colours it wears,
 *   or `null` for the neutral one. The domain picks it, so a category keeps
 *   its colour from one record to the next.
 */
interface SpanCategory {
  readonly id: string
  readonly label: string
  readonly colourSlot: number | null
}

/**
 * A labelled stretch of time, from `start` to `end`, both included. `note` is
 * absent rather than `undefined` when there is none.
 */
interface Span {
  readonly start: DateTime.Utc
  readonly end: DateTime.Utc
  readonly category: SpanCategory
  readonly note?: string
}

/**
 * A lane of labelled time spans, with no value to plot — drawn under the time
 * axis rather than against a value axis.
 *
 * - `id`, `label`: as on a `PointSeries`.
 * - `spans`: sorted ascending by `start`. They may overlap or leave gaps; a
 *   gap is time no span covers.
 */
interface SpanSeries {
  readonly kind: 'spans'
  readonly id: string
  readonly label: string
  readonly spans: readonly Span[]
}

/** Whether `span` covers the instant `epochMillis`, both ends included. */
const covers = (span: Span, epochMillis: number): boolean =>
  span.start.epochMillis <= epochMillis && span.end.epochMillis >= epochMillis

/**
 * The spans a crosshair reads off `series` at `time`.
 *
 * @returns Every span covering `time`, in series order — several where spans
 *   overlap, none in a gap
 *
 * @remarks
 * A linear scan: a long span can cover `time` however far back it started, so
 * no prefix of the spans can be skipped.
 */
const spansAt = (series: SpanSeries, time: DateTime.Utc): readonly Span[] =>
  series.spans.filter((span) => covers(span, time.epochMillis))

/** A sort key putting the neutral colour after every slot. */
const slotOrder = (category: SpanCategory): number => category.colourSlot ?? COLOUR_SLOTS

/**
 * The categories `series`' spans fall in — what its legend lists.
 *
 * @returns Each category once, by colour slot, the neutral ones last; equal
 *   slots keep the order their first span appears in
 */
const categoriesOf = (series: SpanSeries): readonly SpanCategory[] => {
  const byId = new Map<string, SpanCategory>()
  for (const span of series.spans) {
    if (!byId.has(span.category.id)) byId.set(span.category.id, span.category)
  }
  return [...byId.values()].toSorted((left, right) => slotOrder(left) - slotOrder(right))
}

export { COLOUR_SLOTS, LANE_CAP, categoriesOf, spansAt }
export type { Span, SpanCategory, SpanSeries }
