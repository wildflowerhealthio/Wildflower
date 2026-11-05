import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'

import { ObservationListResponseKind } from './response-kinds/observation-list-response-kind.ts'
import { ObservationResponseKind } from './response-kinds/observation-response-kind.ts'
import { PatientResponseKind } from './response-kinds/patient-response-kind.ts'

/**
 * The three FHIR R4 response kinds — Patient, Observation, Observation-list —
 * each parsing the server's resources and detaching them under the server's
 * root, the one its `tryRecognize` claimed the URL by.
 *
 * @remarks
 * The single definition the archive importer (`har-importer-core`) consumes,
 * by reference, as a module-level constant stable by identity.
 *
 * `mustHaveQuery` on the Observation-list pattern keeps the two Observation
 * kinds disjoint, so the order is not load-bearing; it only fixes the sequence
 * both surfaces route by.
 */
const fhirR4ResponseKinds: readonly HttpResponseKind.HttpResponseKind<DetachedResource.Type>[] = [
  PatientResponseKind,
  ObservationResponseKind,
  ObservationListResponseKind,
]

export { fhirR4ResponseKinds }
