import type { Quantity } from '@wildflowerhealthio/fhir-r4/data-types'
import type {
  Medication as FhirMedication,
  MedicationRequest,
} from '@wildflowerhealthio/fhir-r4/resources'

import { supplyDaysPerFillOf } from './dispense-request.ts'
import { type Dose, unitOrCodeOf } from './dosage.ts'
import { containedMedicationOf } from './medication-slots.ts'

/**
 * A daily dose amortized over a request's dispensed supply: one fill's
 * `dispenseRequest.quantity` spread evenly over the days its
 * `expectedSupplyDuration` lasts, for a request whose dosage instruction states
 * no dose.
 */

/** A quantity whose `value` is known to be present. */
type ValuedQuantity = typeof Quantity.Schema.Type & { readonly value: number }

/**
 * How much of the drug one dispensed unit carries: the Medication's single
 * ingredient's `strength.numerator`, when its `strength.denominator` is one
 * dispensed unit — a value of 1, in no unit or in `dispensedUnit`.
 *
 * @returns `null` for a Medication with no ingredient or several, a strength
 *   with no numerator value, or a denominator other than one dispensed unit
 */
const strengthPerDispensedUnitOf = (
  medication: FhirMedication.Type,
  dispensedUnit: string | null
): ValuedQuantity | null => {
  const [onlyIngredient, ...otherIngredients] = medication.ingredient
  if (onlyIngredient === undefined || otherIngredients.length > 0) return null
  const numerator = onlyIngredient.strength?.numerator ?? null
  const denominator = onlyIngredient.strength?.denominator ?? null
  if (numerator === null || numerator.value === null) return null
  if (denominator === null || denominator.value !== 1) return null
  const denominatorUnit = unitOrCodeOf(denominator)
  if (denominatorUnit !== null && denominatorUnit !== dispensedUnit) return null
  return { ...numerator, value: numerator.value }
}

/** `dispenseRequest.quantity`, when it carries a positive, finite value. */
const dispensedQuantityOf = (request: MedicationRequest.Type): ValuedQuantity | null => {
  const dispensedQuantity = request.dispenseRequest?.quantity ?? null
  if (dispensedQuantity === null) return null
  const { value } = dispensedQuantity
  return value !== null && value > 0 && Number.isFinite(value)
    ? { ...dispensedQuantity, value }
    : null
}

/**
 * The daily dose one fill amounts to when taken evenly over its supply:
 * `dispenseRequest.quantity` ÷ the days one fill lasts
 * ({@link supplyDaysPerFillOf}). When the contained Medication (see
 * `containedMedicationOf`) states the strength of one dispensed unit
 * ({@link strengthPerDispensedUnitOf}), the amount is scaled by it and is in
 * the strength's unit (mg/day); otherwise it stays in the dispensed quantity's
 * unit (capsule/day, or no unit).
 *
 * @returns `null` without a positive dispensed quantity and a positive supply
 *   duration, or when the amount is not finite
 *
 * @remarks
 * Repeats do not change the dose: every fill is one `quantity` over one
 * `expectedSupplyDuration`. The amortized dose assumes the whole fill is taken,
 * evenly — an as-needed drug reads as a steady daily dose.
 */
const amortizedDoseOf = (request: MedicationRequest.Type): Dose | null => {
  const dispensedQuantity = dispensedQuantityOf(request)
  if (dispensedQuantity === null) return null
  const supplyDaysPerFill = supplyDaysPerFillOf(request)
  if (supplyDaysPerFill === null) return null
  const dispensedUnit = unitOrCodeOf(dispensedQuantity)
  const containedMedication = containedMedicationOf(request)
  const strengthPerDispensedUnit =
    containedMedication === null
      ? null
      : strengthPerDispensedUnitOf(containedMedication, dispensedUnit)
  const amortizedAmount =
    strengthPerDispensedUnit === null
      ? dispensedQuantity.value / supplyDaysPerFill
      : (dispensedQuantity.value * strengthPerDispensedUnit.value) / supplyDaysPerFill
  if (!Number.isFinite(amortizedAmount)) return null
  return {
    amount: amortizedAmount,
    rangeLow: null,
    unit:
      strengthPerDispensedUnit === null ? dispensedUnit : unitOrCodeOf(strengthPerDispensedUnit),
    per: 'd',
    derivation: 'amortized',
  }
}

export { amortizedDoseOf }
