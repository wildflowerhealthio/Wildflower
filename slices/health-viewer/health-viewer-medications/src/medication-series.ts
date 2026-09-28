import { DateTime } from 'effect'
import type { LevelSeries, SeriesSource } from 'health-viewer-fundamentals'
import {
  type DoseBasis,
  type DoseRegimen,
  type MedicationRequestWithId,
  medicationRequestsToDoseRegimens,
} from 'medication-core/fhir'

import { type MedicationSeriesKey, medicationSeriesIdOf } from './medication-series-key.ts'

/**
 * One regimen's dose as a level: a `StyledLevel` that also names the
 * `MedicationRequest` it was read from, so a readout can link back to it.
 */
interface DoseLevel extends LevelSeries.StyledLevel {
  readonly requestId: string
}

/**
 * A medication's dose over time, in one unit and on one basis: a
 * `LevelSeries` whose levels are {@link DoseLevel}s and which carries the key
 * its `id` encodes.
 */
interface MedicationSeries extends LevelSeries.LevelSeries {
  readonly key: MedicationSeriesKey
  readonly levels: readonly DoseLevel[]
}

/** The readout note each dose basis is shown with, beside the dose. */
const DOSE_BASIS_NOTES: Readonly<Record<DoseBasis, string>> = {
  administration: 'per dose',
  d: 'per day',
}

/**
 * The unit a medication series is shown in: the dose unit, with `/d` appended
 * for a daily total (`mg/d`, or `/d` alone when the request stated no unit).
 *
 * @remarks
 * The basis is part of the key, so a drug with both a per-dose and a per-day
 * series would otherwise list two rows labelled alike in one unit; the suffix
 * tells them apart wherever the unit is shown.
 */
const displayUnitOf = (key: MedicationSeriesKey): string | null =>
  key.doseBasis === 'd' ? `${key.doseUnit ?? ''}/d` : key.doseUnit

/**
 * The key of the series `regimen` joins: its normalised name — or, when that
 * is empty, `#` and its request id, so unrelated unnamed requests never merge —
 * with its dose unit and basis.
 */
const medicationSeriesKeyOf = (regimen: DoseRegimen): MedicationSeriesKey => ({
  medication: regimen.normalizedName === '' ? `#${regimen.requestId}` : regimen.normalizedName,
  doseUnit: regimen.unit,
  doseBasis: regimen.per,
})

/**
 * The level `regimen` plots as before a later regimen clips it: its dose over
 * its whole period, a dose range's floor as the band's `low`, the basis as the
 * note, and a dashed line while the request is on hold.
 */
const doseLevelOf = (regimen: DoseRegimen): DoseLevel => ({
  start: regimen.start,
  end: regimen.end,
  value: regimen.amount,
  ...(regimen.rangeLow === null ? {} : { low: regimen.rangeLow }),
  note: DOSE_BASIS_NOTES[regimen.per],
  lineStyle: regimen.status === 'on-hold' ? 'dashed' : 'solid',
  requestId: regimen.requestId,
})

/**
 * End `doseLevel` no later than `nextStart`, the start of the regimen after
 * it; an open level ends there too, and one that already ended by then is
 * returned as it is.
 */
const clipToNextStart = (doseLevel: DoseLevel, nextStart: DateTime.Utc): DoseLevel =>
  doseLevel.end !== null && DateTime.lessThanOrEqualTo(doseLevel.end, nextStart)
    ? doseLevel
    : { ...doseLevel, end: nextStart }

/**
 * Order regimens by start, then — for equal starts — by end, an open regimen
 * after any closed one. Zero for regimens alike on both.
 */
const compareRegimensByStartThenEnd = (left: DoseRegimen, right: DoseRegimen): number => {
  if (left.start.epochMillis !== right.start.epochMillis) {
    return left.start.epochMillis - right.start.epochMillis
  }
  if (left.end === null || right.end === null) {
    return Number(left.end === null) - Number(right.end === null)
  }
  return left.end.epochMillis - right.end.epochMillis
}

/**
 * Merge dose regimens into the step lines the chart draws: one series per
 * medication, dose unit and dose basis.
 *
 * @param regimens - Read by `medication-core/fhir`'s
 *   `medicationRequestsToDoseRegimens`, in any order
 * @returns One series per distinct {@link MedicationSeriesKey}, in
 *   first-appearance order
 *
 * @remarks
 * Within a series, levels sort by start and each ends no later than the next
 * one's start, so where two requests overlap the later one is in effect from
 * its start. Of regimens starting together, the one running longest (an open
 * one longest of all) sorts last and so stays in effect; remaining ties keep
 * input order. The label is the display name of the last regimen in that
 * order. Doses are plotted from zero: a dose is a non-negative magnitude, and
 * a zoomed-in baseline would overstate a change.
 */
const doseRegimensToSeries = (regimens: readonly DoseRegimen[]): readonly MedicationSeries[] => {
  const regimensBySeriesId = new Map<
    string,
    { key: MedicationSeriesKey; regimens: DoseRegimen[] }
  >()
  for (const regimen of regimens) {
    const key = medicationSeriesKeyOf(regimen)
    const id = medicationSeriesIdOf(key)
    const existing = regimensBySeriesId.get(id)
    if (existing === undefined) {
      regimensBySeriesId.set(id, { key, regimens: [regimen] })
    } else {
      existing.regimens.push(regimen)
    }
  }

  return [...regimensBySeriesId.entries()].map(([id, { key, regimens: seriesRegimens }]) => {
    // `toSorted` is stable, so full ties keep input order.
    const sortedRegimens = seriesRegimens.toSorted(compareRegimensByStartThenEnd)
    const levels = sortedRegimens.map((regimen, index) => {
      const nextRegimen = sortedRegimens[index + 1]
      const doseLevel = doseLevelOf(regimen)
      return nextRegimen === undefined ? doseLevel : clipToNextStart(doseLevel, nextRegimen.start)
    })
    return {
      kind: 'levels',
      id,
      key,
      label: sortedRegimens[sortedRegimens.length - 1].name,
      unit: displayUnitOf(key),
      valueScale: 'from-zero',
      levels,
    }
  })
}

/**
 * Read a patient's `MedicationRequest`s as medication series — the source's
 * `read`.
 *
 * @remarks
 * `undated` and `dropped` are `medicationRequestsToDoseRegimens`' counts, passed
 * through: a request that yields a regimen always lands in exactly one level,
 * so nothing is lost after that step.
 */
const medicationRequestsToSeries = (
  requests: readonly MedicationRequestWithId[]
): SeriesSource.Reading<MedicationSeries> => {
  const { regimens, undated, dropped } = medicationRequestsToDoseRegimens(requests)
  return { series: doseRegimensToSeries(regimens), undated, dropped }
}

export { DOSE_BASIS_NOTES, displayUnitOf, doseRegimensToSeries, medicationRequestsToSeries }
export type { DoseLevel, MedicationSeries }
