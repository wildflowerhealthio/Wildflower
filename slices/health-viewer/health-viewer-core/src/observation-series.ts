import { type DateTime, Option, Schema } from 'effect'
import type { Observation } from 'fhir-r4/resources'

import {
  type ObservationSeries,
  type ObservationSeriesKey,
  type SeriesKind,
  type SeriesPoint,
  seriesId,
} from './series.ts'

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
const ReferenceRangeView = Schema.Struct({
  low: Schema.optional(Schema.NullOr(QuantityView)),
  high: Schema.optional(Schema.NullOr(QuantityView)),
})

/** The three `value[x]` slots the viewer can plot, shared by a resource and a component. */
const valueFields = {
  valueQuantity: Schema.optional(Schema.NullOr(QuantityView)),
  valueInteger: nullableNumber,
  valueBoolean: nullableBoolean,
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
 * The instant a reading is plotted at, in FHIR's own order of specificity.
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

/** The numeric value and its unit / kind, read off a `value[x]` slot set. */
interface NumericValue {
  readonly value: number
  readonly unit: string | null
  readonly kind: SeriesKind
}

/**
 * The plottable number a `value[x]` slot set carries.
 *
 * @returns `null` for anything the viewer cannot plot — a string, a concept, a
 *   range, or no value at all
 *
 * @remarks
 * A quantity's unit falls back to its UCUM `code`, so `{ code: 'mmol/L' }` and
 * `{ unit: 'mmol/L' }` land in the same series.
 */
const numericValue = (slots: ValueSlots): NumericValue | null => {
  const quantity = slots.valueQuantity
  if (
    quantity !== null &&
    quantity !== undefined &&
    quantity.value !== null &&
    quantity.value !== undefined
  ) {
    return {
      value: quantity.value,
      unit: quantity.unit ?? quantity.code ?? null,
      kind: 'quantity',
    }
  }
  const integer = slots.valueInteger
  if (integer !== null && integer !== undefined)
    return { value: integer, unit: null, kind: 'integer' }
  const boolean = slots.valueBoolean
  if (boolean !== null && boolean !== undefined) {
    return { value: boolean ? 1 : 0, unit: null, kind: 'boolean' }
  }
  return null
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

/** A plottable reading, less the instant — attached once the caller knows it is dated. */
interface Reading {
  readonly key: ObservationSeriesKey
  readonly label: string
  readonly unit: string | null
  readonly kind: SeriesKind
  readonly value: number
  readonly bounds: { readonly low?: number; readonly high?: number }
}

/**
 * The readings one observation contributes: one per component, plus one for
 * its own `value[x]` when it carries one.
 *
 * @returns Zero readings when nothing plottable is present
 *
 * @remarks
 * A component reads its own code, unit and range, under a label naming both
 * levels (`"Blood pressure · Systolic"`). A panel carrying both a summary
 * value and components yields both — neither is silently lost.
 */
const readingsOf = (observation: ObservationValue): readonly Reading[] => {
  const concept = observation.code ?? null
  const outerKey = concept === null ? null : conceptKey(concept)
  const outerLabel =
    concept === null || outerKey === null ? null : conceptLabel(concept, outerKey.code)
  const readings: Reading[] = []

  const push = (
    key: { system: string | null; code: string } | null,
    label: string,
    numeric: NumericValue | null,
    ranges: readonly ReferenceRangeValue[] | null | undefined
  ): void => {
    if (key === null || numeric === null) return
    readings.push({
      key: { kind: 'observation', system: key.system, code: key.code, unit: numeric.unit },
      label,
      unit: numeric.unit,
      kind: numeric.kind,
      value: numeric.value,
      bounds: rangeBounds(ranges),
    })
  }

  if (outerKey !== null && outerLabel !== null) {
    push(outerKey, outerLabel, numericValue(observation), observation.referenceRange)
  }

  for (const component of observation.component ?? []) {
    const componentConcept = component.code ?? null
    const key = componentConcept === null ? null : conceptKey(componentConcept)
    if (componentConcept === null || key === null) continue
    const componentLabel = conceptLabel(componentConcept, key.code)
    const label = outerLabel === null ? componentLabel : `${outerLabel} · ${componentLabel}`
    push(key, label, numericValue(component), component.referenceRange)
  }

  return readings
}

/** The `Observation.category` code a series is filed under. */
const categoryOf = (observation: ObservationValue): string | null => {
  const first = (observation.category ?? [])[0]
  if (first === undefined) return null
  return (first.coding ?? [])[0]?.code ?? null
}

/** What {@link observationsToSeries} returns. */
interface ObservationSeriesResult {
  /** One entry per distinct series key, in first-appearance order. */
  readonly series: readonly ObservationSeries[]
  /** Observations that carried a plottable value but no resolvable effective time. */
  readonly undated: number
  /** Observations that contributed nothing: an excluded status, or no plottable value. */
  readonly dropped: number
}

/**
 * Turn decoded FHIR `Observation`s into the plottable series the viewer draws.
 *
 * @param observations - Decoded resources, in any order
 * @returns The series, plus counts of what did not make it in so the UI can
 *   say "12 results could not be dated" rather than silently shrinking
 *
 * @remarks
 * Readings group by {@link seriesId}, so one code in two units is two series
 * rather than one line that jumps scale. A series takes its metadata from its
 * first reading in input order. Every observation moves at most one counter.
 */
const observationsToSeries = (
  observations: readonly ObservationResource[]
): ObservationSeriesResult => {
  const byId = new Map<string, { meta: Reading; points: SeriesPoint[]; category: string | null }>()
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
    // "has neither" is `dropped` — two different things for the UI to say.
    const time = effectiveTime(observation)
    if (time === null) {
      undated += 1
      continue
    }
    const category = categoryOf(observation)
    for (const reading of readings) {
      const id = seriesId(reading.key)
      const point: SeriesPoint = { time, value: reading.value, ...reading.bounds }
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, { meta: reading, points: [point], category })
      } else {
        existing.points.push(point)
      }
    }
  }

  const series = [...byId.values()].map(({ meta, points, category }): ObservationSeries => ({
    key: meta.key,
    label: meta.label,
    unit: meta.unit,
    category,
    // `toSorted` is stable, so equal times keep input order.
    points: points.toSorted((left, right) => left.time.epochMillis - right.time.epochMillis),
    kind: meta.kind,
  }))

  return { series, undated, dropped }
}

export type { ObservationResource, ObservationSeriesResult }
export { EXCLUDED_STATUSES, LOINC_SYSTEM, observationsToSeries }
