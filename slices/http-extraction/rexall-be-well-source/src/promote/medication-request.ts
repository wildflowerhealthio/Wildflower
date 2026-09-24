import { Option, pipe, Schema } from 'effect'

import type { MedicationRequest } from 'fhir-r4/resources'

import { CarebookExtension } from '../carebook.ts'
import { linkContainedMedication, promoteContained } from './contained-medication.ts'
import { DecodedCodeableConcept } from './decoded-r4.ts'
import { withCanonicalDinOnMedicationConcept } from './din.ts'
import { liftExtension, promoteExtension } from './lift.ts'
import { liftRequestMedicationProcessor, liftRequestStoreLocatorUrl } from './pharmacy-location.ts'
import { promoteRepeatsAvailable } from './repeats-available.ts'
import { withSupplyDurationInDays } from './supply-days.ts'

/** `medicationrequest/…/do-not-perform`: the flag STU3 had no slot for. */
const DoNotPerform = Schema.pluck(Schema.Struct({ valueBoolean: Schema.Boolean }), 'valueBoolean')

/** `medicationrequest/…/request-type`: the `fill | refill` category. */
const RequestType = Schema.pluck(
  Schema.Struct({ valueCodeableConcept: DecodedCodeableConcept }),
  'valueCodeableConcept'
)

/** `do-not-perform` → `doNotPerform`. */
const liftDoNotPerform = promoteExtension(
  liftExtension(CarebookExtension.DoNotPerform, DoNotPerform),
  (request: MedicationRequest.Type, doNotPerform) => Option.some({ ...request, doNotPerform })
)

/** `request-type` → appended to `category`. */
const liftRequestType = promoteExtension(
  liftExtension(CarebookExtension.RequestType, RequestType),
  (request: MedicationRequest.Type, requestType) =>
    Option.some({ ...request, category: [...request.category, requestType] })
)

/** The `dispenseRequest`-local promotions, when there is a `dispenseRequest`. */
const promoteDispenseRequest = (request: MedicationRequest.Type): MedicationRequest.Type =>
  request.dispenseRequest === null
    ? request
    : {
        ...request,
        dispenseRequest: pipe(
          request.dispenseRequest,
          withSupplyDurationInDays,
          promoteRepeatsAvailable
        ),
      }

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
 */
const promoteMedicationRequest = (request: MedicationRequest.Type): MedicationRequest.Type =>
  pipe(
    request,
    liftDoNotPerform,
    liftRequestType,
    liftRequestMedicationProcessor,
    liftRequestStoreLocatorUrl,
    promoteContained,
    withCanonicalDinOnMedicationConcept,
    linkContainedMedication,
    promoteDispenseRequest
  )

export { promoteMedicationRequest }
