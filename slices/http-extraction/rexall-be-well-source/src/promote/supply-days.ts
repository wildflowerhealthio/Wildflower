import { Code } from 'fhir-r4/data-types'
import type { Quantity } from 'fhir-r4/data-types'
import type { MedicationDispense, MedicationRequestDispenseRequest } from 'fhir-r4/resources'

/**
 * Supply durations get their unit. The dialect emits `{ value }` with no
 * `unit`/`system`/`code` on both `dispenseRequest.expectedSupplyDuration` and
 * `MedicationDispense.daysSupply`; both are days, so the UCUM `d` is spelled
 * out.
 */

/** UCUM, the code system FHIR quantities use for units of measure. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** UCUM code and display for a day, the unit Rexall's supply durations are in. */
const UCUM_DAY = { code: 'd', unit: 'day' } as const

/**
 * The day unit on a quantity that carries a value and names no unit of its
 * own — a source that starts sending units is left alone.
 */
const withDayUnit = (quantity: Quantity.Type | null): Quantity.Type | null =>
  quantity === null || quantity.value === null || quantity.unit !== null || quantity.code !== null
    ? quantity
    : { ...quantity, unit: UCUM_DAY.unit, system: UCUM_SYSTEM, code: Code.make(UCUM_DAY.code) }

/** The UCUM day unit on a bare `expectedSupplyDuration`. */
const withSupplyDurationInDays = (
  dispenseRequest: typeof MedicationRequestDispenseRequest.Schema.Type
): typeof MedicationRequestDispenseRequest.Schema.Type => ({
  ...dispenseRequest,
  expectedSupplyDuration: withDayUnit(dispenseRequest.expectedSupplyDuration),
})

/** The UCUM day unit on a bare `daysSupply`. */
const withDaysSupplyInDays = (dispense: MedicationDispense.Type): MedicationDispense.Type => ({
  ...dispense,
  daysSupply: withDayUnit(dispense.daysSupply),
})

export { withDaysSupplyInDays, withSupplyDurationInDays }
