import { Option, pipe, Struct } from 'effect'

import type { MedicationDispense } from 'fhir-r4/resources'

import { promoteContained } from './contained-medication.ts'
import { withCanonicalDinOnMedicationConcept } from './din.ts'
import { promoteDispensePharmacy } from './pharmacy-location.ts'
import { withDayUnit } from './supply-days.ts'

/**
 * Promotes carebook-dialect extensions on a `MedicationDispense` into the
 * conventional FHIR R4 fields that already exist for them:
 * `medication-processor` → `location`, `external-system-source` +
 * `external-store-id` → the store-locator URL on `location.reference`
 * (mirroring the request's `dispenseRequest.performer`), a canonical DIN coding
 * beside the vendor one, the UCUM day unit onto `daysSupply`, and the same
 * contained-Medication promotions the request path performs.
 *
 * @remarks
 * The `contained` pass is symmetry with the request path rather than an
 * observed need — see AGENTS.md under "Extension Promotion".
 */
const promoteMedicationDispense = (dispense: MedicationDispense.Type): MedicationDispense.Type =>
  pipe(
    dispense,
    promoteDispensePharmacy,
    Struct.evolve({
      contained: promoteContained,
      medicationCodeableConcept: withCanonicalDinOnMedicationConcept,
      daysSupply: (daysSupply) =>
        Option.fromNullable(daysSupply).pipe(Option.map(withDayUnit), Option.getOrNull),
    })
  )

export { promoteMedicationDispense }
