import { adoptUnderRecognizedRoot } from '@wildflowerhealthio/fhir-r4-adoption'
import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import type { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'

import { ObservationListResponseKind } from './response-kinds/observation-list-response-kind.ts'
import { ObservationResponseKind } from './response-kinds/observation-response-kind.ts'
import { PatientResponseKind } from './response-kinds/patient-response-kind.ts'

/**
 * The three FHIR R4 response kinds — Patient, Observation, Observation-list —
 * each adopted so its resources key in `<root>/<Type>` of the root its own `tryRecognize`
 * mints for the response's URL.
 *
 * @remarks
 * The single definition the archive importer (`har-importer-core`) consumes,
 * by reference. A module-level constant — the combinator takes no source
 * parameter, so the array is stable by identity.
 *
 * `mustHaveQuery` on the Observation-list pattern keeps the two Observation
 * kinds disjoint, so the order is not load-bearing; it only fixes the sequence
 * both surfaces route by.
 */
const unadopted: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  PatientResponseKind,
  ObservationResponseKind,
  ObservationListResponseKind,
]

const fhirR4ResponseKinds: readonly HttpResponseKind.HttpResponseKind<FhirResourceWithId>[] =
  unadopted.map(adoptUnderRecognizedRoot)

export { fhirR4ResponseKinds }
