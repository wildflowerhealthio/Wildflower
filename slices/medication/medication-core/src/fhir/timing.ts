import type { Timing } from 'fhir-r4/data-types'

/** What a dosage's `Timing` says about how often a dose is taken, as a rate per day. */

/**
 * Days per `Timing.repeat.periodUnit`, for the units a daily total is
 * normalised from. `mo` is taken as 30 days. `s`, `min` and `a` are absent: a
 * schedule stated in them keeps its per-administration dose.
 */
const DAYS_PER_PERIOD_UNIT: Readonly<Partial<Record<Timing.UnitOfTime, number>>> = {
  h: 1 / 24,
  d: 1,
  wk: 7,
  mo: 30,
}

/**
 * Scale an amount taken per administration to the total taken per day:
 * `amountPerAdministration × frequency / periodInDays`, where `periodInDays` is
 * `period` in `periodUnit`s converted by {@link DAYS_PER_PERIOD_UNIT}.
 *
 * @returns `null` unless `timing.repeat` states a `frequency`, a `period` that
 *   comes to a positive number of days, and a `periodUnit` in
 *   {@link DAYS_PER_PERIOD_UNIT}
 */
const scaleToDailyTotal = (
  amountPerAdministration: number,
  timing: typeof Timing.Schema.Type | null
): number | null => {
  const repeat = timing?.repeat ?? null
  if (repeat === null || repeat.frequency === null || repeat.period === null) return null
  const daysPerPeriodUnit =
    repeat.periodUnit === null ? undefined : DAYS_PER_PERIOD_UNIT[repeat.periodUnit]
  if (daysPerPeriodUnit === undefined) return null
  const periodInDays = repeat.period * daysPerPeriodUnit
  if (periodInDays <= 0) return null
  return (amountPerAdministration * repeat.frequency) / periodInDays
}

export { DAYS_PER_PERIOD_UNIT, scaleToDailyTotal }
