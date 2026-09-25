import { Array as Arr, flow, Option, pipe, Schema, Struct } from 'effect'

import type { MedicationRequest } from 'fhir-r4/resources'
import { whenPresent } from 'kitchen-sink'

import { CarebookExtension } from '../carebook.ts'
import { linkContainedMedication, promoteContained } from './contained-medication.ts'
import { DecodedCodeableConcept } from './decoded-r4.ts'
import { withCanonicalDinOnMedicationConcept } from './din.ts'
import { atUrl, promoteExtension } from './extension-lift.ts'
import { promoteRequestPharmacy } from './pharmacy-location.ts'
import { promoteRepeatsAvailable } from './repeats-available.ts'
import { withSupplyDurationInDays } from './supply-days.ts'

/** `medicationrequest/…/do-not-perform`: the flag STU3 had no slot for. */
const DoNotPerform = Schema.pluck(Schema.Struct({ valueBoolean: Schema.Boolean }), 'valueBoolean')

/** `medicationrequest/…/request-type`: the `fill | refill` category. */
const RequestType = Schema.pluck(
  Schema.Struct({ valueCodeableConcept: DecodedCodeableConcept }),
  'valueCodeableConcept'
)

/** `do-not-perform` → `doNotPerform`, an exact 1:1. */
const liftDoNotPerform = promoteExtension(
  atUrl(CarebookExtension.DoNotPerform, DoNotPerform),
  (request: MedicationRequest.Type, doNotPerform) => Option.some({ ...request, doNotPerform })
)

/**
 * `request-type` → `category`. Appended rather than assigned: `category` is a
 * list of independent classifications, and fill-vs-refill is one more of them
 * beside any the request already carries.
 */
const liftRequestType = promoteExtension(
  atUrl(CarebookExtension.RequestType, RequestType),
  (request: MedicationRequest.Type, requestType) =>
    Option.some(
      Struct.evolve(request, { category: (category) => Arr.append(category, requestType) })
    )
)

/** The `dispenseRequest`-local promotions, when there is a `dispenseRequest`. */
const promoteDispenseRequest = (request: MedicationRequest.Type): MedicationRequest.Type =>
  Struct.evolve(request, {
    dispenseRequest: (dispenseRequest) =>
      whenPresent(dispenseRequest, flow(withSupplyDurationInDays, promoteRepeatsAvailable)),
  })

/**
 * Promotes carebook-dialect extensions on a `MedicationRequest` into the
 * conventional FHIR R4 fields that already exist for them: `do-not-perform` →
 * `doNotPerform`, `request-type` → `category`, `medication-processor` →
 * `dispenseRequest.performer`, `external-system-source` + `external-store-id` →
 * the store-locator URL on `dispenseRequest.performer.reference`, the
 * remaining-repeats `modifierExtension` pair → one `RepeatsAvailable`, a
 * canonical DIN coding beside the vendor one, the UCUM day unit onto
 * `expectedSupplyDuration`, and the orphaned contained Medication linked as
 * `medication[x]`.
 *
 * @remarks
 * A **dialect post-step, deliberately outside `fhir-stu3-as-r4`**, run on the
 * R4 resources that transform produces. Each step decodes what it reads and
 * drops exactly the entry it read, only once the value has landed. The full
 * table of what moves, what deliberately does not, and why, is in this
 * package's AGENTS.md under "Extension Promotion".
 *
 * The inline concept is twinned **after** the link: linking retires the inline
 * concept, so only a request left unlinked still has one to twin.
 */
const promoteMedicationRequest = (request: MedicationRequest.Type): MedicationRequest.Type =>
  pipe(
    request,
    liftDoNotPerform,
    liftRequestType,
    promoteRequestPharmacy,
    Struct.evolve({ contained: promoteContained }),
    linkContainedMedication,
    Struct.evolve({ medicationCodeableConcept: withCanonicalDinOnMedicationConcept }),
    promoteDispenseRequest
  )

export { promoteMedicationRequest }
