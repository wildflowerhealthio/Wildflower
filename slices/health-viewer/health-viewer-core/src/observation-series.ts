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

// The fields this adapter reads — the `value[x]` / `effective[x]` choice slots
// above all — are typed loosely (often `any`) on a decoded resource, because
// they resolve through fhir-r4's datatype registry. Rather than read `any`, the
// resource is taken as `unknown` and decoded through the permissive local
// schema below, naming only what the viewer plots. Effect's `Struct` ignores
// excess keys on decode, so a narrow schema happily reads a much larger object.
//
// The unions are not defensiveness for its own sake: a FHIR `uri` is a plain
// string on the wire but a `URL` on a fully-typed decoded resource, and a FHIR
// `dateTime` is an ISO string on the wire but an Effect `DateTime.Utc` once
// decoded. Accepting both shapes is what lets this adapter read either — see
// fhir-r4's Consumer Gotchas Reference.
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
 * `Observation.status` codes whose readings are never plotted.
 *
 * @remarks
 * FHIR's own "this never happened" statuses. Every other status — including
 * `preliminary`, `registered` and `unknown` — is plotted: a patient-facing
 * viewer that hid unverified results would under-report, and the status stays
 * on the source resource for a renderer that wants to mark them.
 */
const EXCLUDED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'entered-in-error'])

/** The coding system a series key prefers when an `Observation.code` carries several. */
const LOINC_SYSTEM = 'http://loinc.org'

/**
 * Drop trailing slashes from a coding system uri.
 *
 * @remarks
 * `new URL('http://loinc.org').href` is `'http://loinc.org/'`, so a decoded
 * resource's system would not compare equal to {@link LOINC_SYSTEM} without
 * this. Applied on the way into a series key too, so the same code keys
 * identically whether it arrived decoded or off the wire.
 */
const canonicalSystem = (href: string | null): string | null =>
  href === null ? null : href.replace(/\/+$/, '')

/**
 * The `system` / `code` pair a series key is built from.
 *
 * @returns The preferred coding's system and code, the concept's `text` with a
 *   `null` system when no coding carries a code, or `null` when the concept
 *   says nothing usable
 *
 * @remarks
 * LOINC wins when present — it is the vocabulary the viewer's grouping and
 * labels assume — otherwise the first coding carrying a code, in the order the
 * resource lists them.
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
 * The instant a reading is plotted at, by FHIR's own specificity order:
 * `effectiveDateTime`, then `effectivePeriod.start`, then `effectiveInstant`,
 * then `issued`.
 *
 * @returns The instant, or `null` when the resource dates itself in none of
 *   those slots
 *
 * @remarks
 * `issued` comes last because it is when the result was *released*, not when
 * it was observed — a usable fallback, never a preference over a stated
 * effective time.
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
 * @returns `null` for a value the viewer cannot plot — a string, a codeable
 *   concept, a range, or no value at all
 *
 * @remarks
 * A quantity's unit falls back to its UCUM `code` when the human-readable
 * `unit` is absent, so `{ value: 5.4, code: 'mmol/L' }` and
 * `{ value: 5.4, unit: 'mmol/L' }` land in the same series. A boolean plots as
 * 0/1, against the `[0, 1]` axis its series kind earns it.
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

/**
 * One plottable reading extracted from an observation or one of its
 * components — everything but the instant, which the caller attaches once it
 * knows the observation is dated at all.
 */
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
 * @param observation - An observation already past the status filter
 * @returns Zero readings when nothing plottable is present
 *
 * @remarks
 * A component's reading takes the component's own code, unit and reference
 * range, and a label naming both levels (`"Blood pressure · Systolic"`), so
 * two components of one panel stay distinguishable in the catalogue. An
 * observation may carry both a top-level value and components (a panel with a
 * summary value); both are read, so neither is silently lost.
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
 * @returns The series plus the two counts of what did not make it in, so the
 *   UI can say "12 results could not be dated" rather than silently shrinking
 *
 * @remarks
 * Readings group by {@link seriesId} of their key, so the same code reported
 * in two units yields two series rather than one line that jumps scale. A
 * series takes its label, unit, category and kind from its first reading in
 * input order; its points are sorted by time, with equal times keeping input
 * order.
 *
 * Every observation moves at most one counter: an excluded status or no
 * plottable value makes it `dropped`, a plottable value with no time makes it
 * `undated`, and neither moves for one that contributes points.
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
