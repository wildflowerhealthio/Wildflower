import { DateTime, Option, Schema } from 'effect'
import type { Observation } from 'fhir-r4/resources'
import type { PointSeries, SeriesSource } from 'health-viewer-fundamentals'

import { type ObservationSeriesKey, observationSeriesIdOf } from './observation-series-key.ts'

/**
 * A plottable line of observation readings, sharing one code and one unit: a
 * `PointSeries` that also carries the key its `id` encodes and the category
 * the catalogue files it under.
 */
interface ObservationSeries extends PointSeries.PointSeries {
  readonly key: ObservationSeriesKey
  /** The FHIR `Observation.category` code (`vital-signs`, `laboratory`, …), or `null`. */
  readonly category: string | null
}

/**
 * Which `value[x]` slot a reading came from, which decides how its line is
 * drawn and its axis fitted.
 */
type ValueType = 'quantity' | 'integer' | 'boolean'

/** A decoded FHIR R4 `Observation` — what this adapter is handed. */
type ObservationResource = Observation.Type

// The `value[x]` / `effective[x]` choice slots type as `any` on a decoded
// resource, and each union below absorbs a wire-vs-decoded asymmetry
// (`uri` → `URL`, `dateTime` → `DateTime.Utc`). Both traps, and why the fix is
// to re-decode through a permissive local schema rather than read `any`, are
// fhir-r4's Consumer Gotchas Reference; `medication-core/fhir` does the same.
const nullableString = Schema.optional(Schema.NullOr(Schema.String))
const nullableNumber = Schema.optional(Schema.NullOr(Schema.Number))
const nullableBoolean = Schema.optional(Schema.NullOr(Schema.Boolean))
const nullableUri = Schema.optional(
  Schema.NullOr(
    Schema.transform(Schema.Union(Schema.String, Schema.instanceOf(URL)), Schema.String, {
      decode: (value) => (typeof value === 'string' ? value : value.href),
      encode: (value) => value,
    })
  )
)
const nullableInstant = Schema.optional(
  Schema.NullOr(Schema.Union(Schema.DateTimeUtc, Schema.DateTimeUtcFromSelf))
)

const CodingView = Schema.Struct({
  system: nullableUri,
  code: nullableString,
  display: nullableString,
})
const ConceptView = Schema.Struct({
  text: nullableString,
  coding: Schema.optional(Schema.NullOr(Schema.Array(CodingView))),
})
const QuantityView = Schema.Struct({
  value: nullableNumber,
  unit: nullableString,
  code: nullableString,
})
/**
 * A `SampledData` as the viewer reads it: every field nullable, so a sample
 * set missing its `origin` or `period` decodes and is then skipped rather than
 * failing the whole observation.
 */
const SampledDataView = Schema.Struct({
  origin: Schema.optional(Schema.NullOr(QuantityView)),
  period: nullableNumber,
  factor: nullableNumber,
  dimensions: nullableNumber,
  data: nullableString,
})
const ReferenceRangeView = Schema.Struct({
  low: Schema.optional(Schema.NullOr(QuantityView)),
  high: Schema.optional(Schema.NullOr(QuantityView)),
})

/** The four `value[x]` slots the viewer can plot, shared by a resource and a component. */
const valueFields = {
  valueQuantity: Schema.optional(Schema.NullOr(QuantityView)),
  valueInteger: nullableNumber,
  valueBoolean: nullableBoolean,
  valueSampledData: Schema.optional(Schema.NullOr(SampledDataView)),
}

const ComponentView = Schema.Struct({
  code: Schema.optional(Schema.NullOr(ConceptView)),
  referenceRange: Schema.optional(Schema.NullOr(Schema.Array(ReferenceRangeView))),
  ...valueFields,
})

const ObservationView = Schema.Struct({
  status: nullableString,
  code: Schema.optional(Schema.NullOr(ConceptView)),
  category: Schema.optional(Schema.NullOr(Schema.Array(ConceptView))),
  effectiveDateTime: nullableInstant,
  effectivePeriod: Schema.optional(
    Schema.NullOr(Schema.Struct({ start: nullableInstant, end: nullableInstant }))
  ),
  effectiveInstant: nullableInstant,
  issued: nullableInstant,
  referenceRange: Schema.optional(Schema.NullOr(Schema.Array(ReferenceRangeView))),
  component: Schema.optional(Schema.NullOr(Schema.Array(ComponentView))),
  ...valueFields,
})

type ConceptValue = Schema.Schema.Type<typeof ConceptView>
type ReferenceRangeValue = Schema.Schema.Type<typeof ReferenceRangeView>
type SampledDataValue = Schema.Schema.Type<typeof SampledDataView>
type ValueSlots = Schema.Schema.Type<typeof ComponentView>

const decodeObservationView = Schema.decodeUnknownOption(ObservationView)

/**
 * `Observation.status` codes whose readings are never plotted — FHIR's own
 * "this never happened" pair.
 *
 * @remarks
 * Every other status, `preliminary` and `unknown` included, is plotted: a
 * patient-facing viewer that hid unverified results would under-report.
 */
const EXCLUDED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'entered-in-error'])

/** The coding system a series key prefers when an `Observation.code` carries several. */
const LOINC_SYSTEM = 'http://loinc.org'

/**
 * Drop trailing slashes from a coding system uri, so a decoded resource's
 * `URL` form (`'http://loinc.org/'`) compares and keys equal to the wire form.
 */
const canonicalSystem = (href: string | null): string | null =>
  href === null ? null : href.replace(/\/+$/, '')

/**
 * The `system` / `code` pair a series key is built from: the LOINC coding if
 * there is one, else the first coding carrying a code, else the concept's
 * `text` with a `null` system.
 *
 * @returns `null` when the concept says nothing usable
 */
const conceptKey = (concept: ConceptValue): { system: string | null; code: string } | null => {
  const coded = (concept.coding ?? []).filter(
    (coding) => coding.code !== null && coding.code !== undefined && coding.code.length > 0
  )
  const preferred = coded.find((coding) => canonicalSystem(coding.system ?? null) === LOINC_SYSTEM)
  const chosen = preferred ?? coded[0]
  if (chosen?.code !== null && chosen?.code !== undefined) {
    return { system: canonicalSystem(chosen.system ?? null), code: chosen.code }
  }
  const text = concept.text
  return text !== null && text !== undefined && text.length > 0
    ? { system: null, code: text }
    : null
}

/** The human label for a concept: its `text`, else a coding's `display`, else the code itself. */
const conceptLabel = (concept: ConceptValue, code: string): string => {
  const text = concept.text
  if (text !== null && text !== undefined && text.length > 0) return text
  const display = (concept.coding ?? []).find(
    (coding) => coding.display !== null && coding.display !== undefined && coding.display.length > 0
  )?.display
  return display ?? code
}

/** A decoded observation, as {@link ObservationView} reads it. */
type ObservationValue = Schema.Schema.Type<typeof ObservationView>

/**
 * The instant a scalar reading is plotted at, in FHIR's own order of
 * specificity.
 *
 * @returns `null` when the resource dates itself in none of the slots
 *
 * @remarks
 * `issued` is last because it is when the result was *released*, not observed
 * — a usable fallback, never a preference over a stated effective time.
 */
const effectiveTime = (observation: ObservationValue): DateTime.Utc | null =>
  observation.effectiveDateTime ??
  observation.effectivePeriod?.start ??
  observation.effectiveInstant ??
  observation.issued ??
  null

/**
 * The instant a `valueSampledData`'s first sample was taken, which every later
 * sample is offset from.
 *
 * @returns `null` when the resource states no effective time
 *
 * @remarks
 * `effectivePeriod.start` leads because a period is how a run of samples says
 * when it ran. `issued` is never used: a sample's time is an offset from a
 * stated start, and a release time is not one — a SampledData dated only by
 * `issued` is `undated`.
 */
const sampledDataStart = (observation: ObservationValue): DateTime.Utc | null =>
  observation.effectivePeriod?.start ??
  observation.effectiveDateTime ??
  observation.effectiveInstant ??
  null

/**
 * A quantity's unit: its `unit`, falling back to its UCUM `code`, so
 * `{ code: 'mmol/L' }` and `{ unit: 'mmol/L' }` land in the same series.
 */
const quantityUnit = (
  quantity: Schema.Schema.Type<typeof QuantityView> | null | undefined
): string | null => quantity?.unit ?? quantity?.code ?? null

/** A plottable number, its unit / value type, and the instant it was taken. */
interface NumericValue {
  readonly value: number
  readonly unit: string | null
  readonly valueType: ValueType
  /** `null` when the observation states no time this value can be placed at. */
  readonly time: DateTime.Utc | null
}

/**
 * A FHIR `decimal`, the only numeric token a `SampledData.data` carries.
 *
 * @remarks
 * Matched whole rather than handed to `Number`, which would read `''` as `0`
 * and accept `Infinity` or `0x1F` — none of which the grammar allows.
 */
const DECIMAL_TOKEN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/

/**
 * One value per numeric sample in a `SampledData`, each at its start + index ×
 * `period` and worth `origin + factor × sample`.
 *
 * @param start - The instant sample 0 was taken, or `null` when the
 *   observation states none — the values still come back, undated, so the
 *   caller can count the observation as `undated` rather than `dropped`
 * @returns No values when the set cannot be read as one timed series — no
 *   `origin.value`, a missing or non-positive `period`, or a `dimensions`
 *   other than 1 (an absent one reads as 1)
 *
 * @remarks
 * `E` (error), `L` / `U` (beyond the detection limits) and any other token
 * that is not a finite decimal are skipped but still counted, so every later
 * sample keeps its own time. Interleaved multi-dimension data is not read: no
 * source produces it, and plotting only its first dimension would mislabel it.
 * The unit is {@link quantityUnit} of `origin`, as for a quantity.
 */
const sampledValues = (
  sampledData: SampledDataValue,
  start: DateTime.Utc | null
): readonly NumericValue[] => {
  const origin = sampledData.origin?.value ?? null
  const period = sampledData.period ?? null
  // `!(period > 0)` also rejects `NaN`: a zero or negative period would stack
  // every sample on one instant or run them backwards from the start.
  if (origin === null || period === null || !(period > 0) || (sampledData.dimensions ?? 1) !== 1) {
    return []
  }
  const factor = sampledData.factor ?? 1
  const unit = quantityUnit(sampledData.origin)
  const tokens = (sampledData.data ?? '').trim().split(/\s+/)
  return tokens.flatMap((token, index): NumericValue[] => {
    if (!DECIMAL_TOKEN.test(token)) return []
    const value = origin + factor * Number(token)
    if (!Number.isFinite(value)) return []
    // An offset past the representable range leaves the sample undated, which
    // counts its observation as `undated` rather than plotting it somewhere wrong.
    const time =
      start === null ? null : Option.getOrNull(DateTime.make(start.epochMillis + index * period))
    return [{ value, unit, valueType: 'quantity', time }]
  })
}

/** The single number a scalar `value[x]` slot carries, or `null` when there is none. */
const scalarValue = (slots: ValueSlots): Omit<NumericValue, 'time'> | null => {
  const quantity = slots.valueQuantity
  if (
    quantity !== null &&
    quantity !== undefined &&
    quantity.value !== null &&
    quantity.value !== undefined
  ) {
    return {
      value: quantity.value,
      unit: quantityUnit(quantity),
      valueType: 'quantity',
    }
  }
  const integer = slots.valueInteger
  if (integer !== null && integer !== undefined)
    return { value: integer, unit: null, valueType: 'integer' }
  const boolean = slots.valueBoolean
  if (boolean !== null && boolean !== undefined) {
    return { value: boolean ? 1 : 0, unit: null, valueType: 'boolean' }
  }
  return null
}

/**
 * The plottable numbers a `value[x]` slot set carries: one for a scalar, one
 * per numeric sample for a `valueSampledData`.
 *
 * @param times - Where a scalar value and sample 0 are placed, from
 *   {@link effectiveTime} and {@link sampledDataStart}
 * @returns No values for anything the viewer cannot plot — a string, a
 *   concept, a range, or no value at all
 *
 * @remarks
 * Units come from {@link quantityUnit}, for a quantity and a sample set alike.
 */
const numericValues = (
  slots: ValueSlots,
  times: { readonly scalar: DateTime.Utc | null; readonly sampled: DateTime.Utc | null }
): readonly NumericValue[] => {
  const scalar = scalarValue(slots)
  if (scalar !== null) return [{ ...scalar, time: times.scalar }]
  const sampledData = slots.valueSampledData
  return sampledData === null || sampledData === undefined
    ? []
    : sampledValues(sampledData, times.sampled)
}

/** The reference-range bounds to bracket a point with: the first range's `low` / `high`. */
const rangeBounds = (
  ranges: readonly ReferenceRangeValue[] | null | undefined
): { readonly low?: number; readonly high?: number } => {
  const first = (ranges ?? [])[0]
  if (first === undefined) return {}
  const low = first.low?.value ?? null
  const high = first.high?.value ?? null
  return { ...(low === null ? {} : { low }), ...(high === null ? {} : { high }) }
}

/** A plottable reading, with the instant it is plotted at when the observation states one. */
interface Reading {
  readonly key: ObservationSeriesKey
  readonly label: string
  readonly unit: string | null
  readonly valueType: ValueType
  readonly value: number
  readonly time: DateTime.Utc | null
  readonly bounds: { readonly low?: number; readonly high?: number }
}

/**
 * The readings one observation contributes: those of each component, plus
 * those of its own `value[x]` — one for a scalar, one per numeric sample for a
 * `valueSampledData`.
 *
 * @returns Zero readings when nothing plottable is present
 *
 * @remarks
 * A component reads its own code, unit and range, under a label naming both
 * levels (`"Blood pressure · Systolic"`). A panel carrying both a summary
 * value and components yields both — neither is silently lost. Every sample
 * of a SampledData takes its slot's first reference range, as a scalar does.
 */
const readingsOf = (observation: ObservationValue): readonly Reading[] => {
  const concept = observation.code ?? null
  const outerKey = concept === null ? null : conceptKey(concept)
  const outerLabel =
    concept === null || outerKey === null ? null : conceptLabel(concept, outerKey.code)
  const times = { scalar: effectiveTime(observation), sampled: sampledDataStart(observation) }
  const readings: Reading[] = []

  const push = (
    key: { system: string | null; code: string } | null,
    label: string,
    numerics: readonly NumericValue[],
    ranges: readonly ReferenceRangeValue[] | null | undefined
  ): void => {
    if (key === null) return
    const bounds = rangeBounds(ranges)
    for (const numeric of numerics) {
      readings.push({
        key: { system: key.system, code: key.code, unit: numeric.unit },
        label,
        unit: numeric.unit,
        valueType: numeric.valueType,
        value: numeric.value,
        time: numeric.time,
        bounds,
      })
    }
  }

  if (outerKey !== null && outerLabel !== null) {
    push(outerKey, outerLabel, numericValues(observation, times), observation.referenceRange)
  }

  for (const component of observation.component ?? []) {
    const componentConcept = component.code ?? null
    const key = componentConcept === null ? null : conceptKey(componentConcept)
    if (componentConcept === null || key === null) continue
    const componentLabel = conceptLabel(componentConcept, key.code)
    const label = outerLabel === null ? componentLabel : `${outerLabel} · ${componentLabel}`
    push(key, label, numericValues(component, times), component.referenceRange)
  }

  return readings
}

/** Whether a reading states the instant it is plotted at. */
const isDated = (reading: Reading): reading is Reading & { readonly time: DateTime.Utc } =>
  reading.time !== null

/** The `Observation.category` code a series is filed under. */
const categoryOf = (observation: ObservationValue): string | null => {
  const first = (observation.category ?? [])[0]
  if (first === undefined) return null
  return (first.coding ?? [])[0]?.code ?? null
}

/**
 * How a yes/no reading is drawn: held flat and stepped, on an axis pinned to
 * `[0, 1]`. Every other value type is a line between readings on a fitted
 * axis.
 */
const presentationOf = (
  valueType: ValueType
): Pick<ObservationSeries, 'interpolation' | 'valueScale'> =>
  valueType === 'boolean'
    ? { interpolation: 'step', valueScale: 'zero-to-one' }
    : { interpolation: 'linear', valueScale: 'fitted' }

/**
 * Turn decoded FHIR `Observation`s into the plottable series the viewer draws.
 *
 * @param observations - Decoded resources, in any order
 * @returns The series, plus counts of what did not make it in so the UI can
 *   say "12 results could not be dated" rather than silently shrinking:
 *   `undated` for observations that carried a plottable value but no
 *   resolvable effective time (for a `valueSampledData`, no stated start to
 *   offset samples from), `dropped` for those that contributed nothing (an
 *   excluded status, or no plottable value)
 *
 * @remarks
 * Readings group by their series id, so one code in two units is two series
 * rather than one line that jumps scale. A series takes its metadata from its
 * first reading in input order, its value type included. A `valueSampledData` contributes one point per
 * numeric sample, so one observation can add many points, but every
 * observation still moves at most one counter.
 */
const observationsToSeries = (
  observations: readonly ObservationResource[]
): SeriesSource.Reading<ObservationSeries> => {
  const byId = new Map<
    string,
    { meta: Reading; points: PointSeries.Point[]; category: string | null }
  >()
  let undated = 0
  let dropped = 0

  for (const resource of observations) {
    const decoded = decodeObservationView(resource)
    if (Option.isNone(decoded)) {
      dropped += 1
      continue
    }
    const observation = decoded.value
    if (EXCLUDED_STATUSES.has(observation.status ?? '')) {
      dropped += 1
      continue
    }
    const readings = readingsOf(observation)
    if (readings.length === 0) {
      dropped += 1
      continue
    }
    // Extraction comes first so "has a value but no date" is `undated` and
    // "has neither" is `dropped` — two different things for the UI to say. An
    // observation plots whole or not at all, so one undated reading leaves the
    // rest unplotted too rather than splitting it across two outcomes.
    if (!readings.every(isDated)) {
      undated += 1
      continue
    }
    const category = categoryOf(observation)
    for (const reading of readings) {
      const id = observationSeriesIdOf(reading.key)
      const point: PointSeries.Point = {
        time: reading.time,
        value: reading.value,
        ...reading.bounds,
      }
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, { meta: reading, points: [point], category })
      } else {
        existing.points.push(point)
      }
    }
  }

  const series = [...byId.entries()].map(([id, { meta, points, category }]): ObservationSeries => ({
    kind: 'points',
    id,
    key: meta.key,
    label: meta.label,
    unit: meta.unit,
    category,
    ...presentationOf(meta.valueType),
    // `toSorted` is stable, so equal times keep input order.
    points: points.toSorted((left, right) => left.time.epochMillis - right.time.epochMillis),
  }))

  return { series, undated, dropped }
}

export type { ObservationResource, ObservationSeries }
export { EXCLUDED_STATUSES, LOINC_SYSTEM, observationsToSeries }
