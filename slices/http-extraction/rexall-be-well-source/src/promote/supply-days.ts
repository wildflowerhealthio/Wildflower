import { Option, Struct } from 'effect'

import { Code } from 'fhir-r4/data-types'
import type { Quantity } from 'fhir-r4/data-types'
import type { MedicationRequestDispenseRequest } from 'fhir-r4/resources'

/**
 * Supply durations get their unit. The dialect emits `{ value }` with no
 * `unit`/`system`/`code` on both `dispenseRequest.expectedSupplyDuration` and
 * `MedicationDispense.daysSupply`; both are days, so the UCUM `d` is spelled
 * out.
 */

/** UCUM, the code system FHIR quantities use for units of measure. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** The unit fields of a quantity measured in days, as UCUM spells them. */
const UCUM_DAY_UNIT: Pick<Quantity.Type, 'unit' | 'system' | 'code'> = {
  unit: 'day',
  system: UCUM_SYSTEM,
  code: Code.make('d'),
}

/**
 * Whether a quantity is the dialect's bare `{ value }`: a number, and no unit
 * of any kind. A quantity that names its own unit is the source speaking for
 * itself, and is never overwritten.
 */
const isBareQuantity = ({ value, unit, code }: Quantity.Type): boolean =>
  value !== null && unit === null && code === null

/** A bare supply duration, read as the days it is. */
const withDayUnit = (quantity: Quantity.Type): Quantity.Type =>
  isBareQuantity(quantity) ? { ...quantity, ...UCUM_DAY_UNIT } : quantity

/** The UCUM day unit on a bare `expectedSupplyDuration`. */
const withSupplyDurationInDays = (
  dispenseRequest: typeof MedicationRequestDispenseRequest.Schema.Type
): typeof MedicationRequestDispenseRequest.Schema.Type =>
  Struct.evolve(dispenseRequest, {
    expectedSupplyDuration: (expectedSupplyDuration) =>
      Option.fromNullable(expectedSupplyDuration).pipe(Option.map(withDayUnit), Option.getOrNull),
  })

export { withDayUnit, withSupplyDurationInDays }
