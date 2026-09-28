import type { Dosage, SimpleQuantity, Timing } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'

import { scaleToDailyTotal } from './timing.ts'

/** What a `MedicationRequest`'s `dosageInstruction` says about the amount taken. */

/**
 * What a {@link Dose}'s amounts are stated per: one `administration`, or a
 * day (`d`, borrowed from FHIR's `UnitsOfTime`) when they are a daily total.
 */
type DoseBasis = 'administration' | Extract<Timing.UnitOfTime, 'd'>

/**
 * How a {@link Dose} was obtained: `stated` by the first `dosageInstruction`'s
 * `doseAndRate` (see {@link firstDoseOf}), or `amortized` — the dispensed
 * supply spread evenly over the days it lasts, for a request that states no
 * dose (see `amortized-dose.ts`).
 */
type DoseDerivation = 'stated' | 'amortized'

/**
 * The dose one request prescribes. `amount` is the value a chart plots and
 * `rangeLow` the bottom of a `doseRange` band; both are stated on the basis
 * `per` names.
 */
interface Dose {
  readonly amount: number
  /** `doseRange.low`, when the dose is a range whose floor shares `unit`. */
  readonly rangeLow: number | null
  readonly unit: string | null
  /** Whether `amount` and `rangeLow` are per administration or a daily total. */
  readonly per: DoseBasis
  /** Whether the dose is stated by the request or amortized over its dispensed supply. */
  readonly derivation: DoseDerivation
}

/** A quantity's `unit`, else its UCUM `code`. */
const unitOrCodeOf = (
  quantity: Pick<typeof SimpleQuantity.Schema.Type, 'unit' | 'code'>
): string | null => quantity.unit ?? quantity.code ?? null

/**
 * The floor a `doseRange.low` sets under a band plotted at its `high`: its
 * `value`, unless `low` states a unit other than `rangeHighUnit`, since a
 * floor in another scale would plot wrong.
 */
const rangeLowAmountOf = (
  rangeLow: typeof SimpleQuantity.Schema.Type | null,
  rangeHighUnit: string | null
): number | null => {
  if (rangeLow === null) return null
  const rangeLowUnit = unitOrCodeOf(rangeLow)
  return rangeLowUnit !== null && rangeLowUnit !== rangeHighUnit ? null : rangeLow.value
}

/**
 * Convert one `doseAndRate` entry to the {@link Dose} it states per
 * administration: its `doseQuantity`, else its `doseRange.high` with
 * `doseRange.low` kept as the band floor (see {@link rangeLowAmountOf}).
 *
 * @returns `null` when neither the quantity nor the range high carries a value
 */
const doseAndRateToDose = (
  doseAndRate: typeof Dosage.DosageDoseAndRateSchema.Type
): Dose | null => {
  const { doseQuantity, doseRange } = doseAndRate
  if (doseQuantity !== null && doseQuantity.value !== null) {
    return {
      amount: doseQuantity.value,
      rangeLow: null,
      unit: unitOrCodeOf(doseQuantity),
      per: 'administration',
      derivation: 'stated',
    }
  }
  const rangeHigh = doseRange?.high ?? null
  if (rangeHigh === null || rangeHigh.value === null) return null
  const rangeHighUnit = unitOrCodeOf(rangeHigh)
  return {
    amount: rangeHigh.value,
    rangeLow: rangeLowAmountOf(doseRange?.low ?? null, rangeHighUnit),
    unit: rangeHighUnit,
    per: 'administration',
    derivation: 'stated',
  }
}

/**
 * The dose the first `dosageInstruction`'s first `doseAndRate` states, as
 * a daily total when the instruction's timing states a frequency per period
 * (see {@link scaleToDailyTotal}), else per administration.
 *
 * @returns `null` when no dose quantity or range high carries a value
 *
 * @remarks
 * Later instructions and later `doseAndRate` entries are not read — a tapering
 * or split regimen plots its first step only.
 */
const firstDoseOf = (request: MedicationRequest.Type): Dose | null => {
  const firstInstruction = request.dosageInstruction[0]
  const firstDoseAndRate = firstInstruction?.doseAndRate[0]
  if (firstDoseAndRate === undefined) return null
  const perAdministrationDose = doseAndRateToDose(firstDoseAndRate)
  if (perAdministrationDose === null) return null
  const { timing } = firstInstruction
  const dailyAmount = scaleToDailyTotal(perAdministrationDose.amount, timing)
  if (dailyAmount === null) return perAdministrationDose
  return {
    amount: dailyAmount,
    rangeLow:
      perAdministrationDose.rangeLow === null
        ? null
        : scaleToDailyTotal(perAdministrationDose.rangeLow, timing),
    unit: perAdministrationDose.unit,
    per: 'd',
    derivation: 'stated',
  }
}

export { firstDoseOf, unitOrCodeOf, type Dose, type DoseBasis, type DoseDerivation }
