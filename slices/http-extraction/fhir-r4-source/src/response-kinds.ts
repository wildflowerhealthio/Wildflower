import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import type { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'

import { ObservationListResponseKind } from './response-kinds/observation-list-response-kind.ts'
import { ObservationResponseKind } from './response-kinds/observation-response-kind.ts'
import { PatientResponseKind } from './response-kinds/patient-response-kind.ts'

/**
 * The three FHIR R4 response kinds — Patient, Observation, Observation-list —
 * each parsing the server's resources as it spelled them, ids and references
 * included; its `tryRecognize` mints the `FhirStyleBaseUrl` family those ids
 * belong to.
 *
 * @remarks
 * The single definition the archive importer (`har-importer-core`) consumes,
 * by reference, as a module-level constant stable by identity.
 *
 * `mustHaveQuery` on the Observation-list pattern keeps the two Observation
 * kinds disjoint, so the order is not load-bearing; it only fixes the sequence
 * both surfaces route by.
 */
const fhirR4ResponseKinds: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  PatientResponseKind,
  ObservationResponseKind,
  ObservationListResponseKind,
]

export { fhirR4ResponseKinds }
