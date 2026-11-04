import { SystemFamily } from '@wildflowerhealthio/http-extraction-fundamentals'

import { ShoppersIdentifierSystem } from './shoppers.ts'

/**
 * The family every Shoppers kind's `tryRecognize` mints: the portal's own
 * namespace for each type's ids, a person's `patientId`, a prescription's id
 * and a dispense's `dispenseId`.
 *
 * @remarks
 * So a Shoppers record's key, `identifier[0]`, is the portal's own identifier
 * for it, and a reference to a person, prescription or dispense names it by
 * that identifier. **Persisted wire format:** these systems are the hash
 * domain of every id a Shoppers import stores under, so changing one orphans
 * everything already imported. A type not listed here has no system, so a
 * kind that ever names one fails loudly (`SystemFamily.systemFor`).
 *
 * Its own leaf module (not `source.ts`) to break the `source.ts` ⇄
 * response-kinds import cycle.
 */
const SHOPPERS_DRUGMART_SYSTEM_FAMILY = SystemFamily.SystemPerResourceType({
  systems: {
    Patient: ShoppersIdentifierSystem.PatientId,
    MedicationRequest: ShoppersIdentifierSystem.PrescriptionId,
    MedicationDispense: ShoppersIdentifierSystem.DispenseId,
  },
})

export { SHOPPERS_DRUGMART_SYSTEM_FAMILY }
