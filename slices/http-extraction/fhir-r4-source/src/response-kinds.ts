import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { ObservationListResponseKind } from './response-kinds/observation-list-response-kind.ts'
import { ObservationResponseKind } from './response-kinds/observation-response-kind.ts'
import { PatientResponseKind } from './response-kinds/patient-response-kind.ts'

/**
 * The three FHIR R4 response kinds — Patient, Observation, Observation-list —
 * each adopted so its resources key under the root its own `tryRecognize`
 * mints for the response's URL.
 *
 * @remarks
 * The single definition both the live scraping plan
 * (`fhir-r4-client-collector`) and the archive importer (`har-importer-core`)
 * consume, by reference. A module-level constant — the combinator takes no
 * source parameter, so the array is stable by identity, which is what the
 * config deep-equal suites and the live==archive parity rest on.
 *
 * The declared element type is the whole `FhirResource` union, which each
 * kind's narrower type satisfies by covariance — so no cast is needed, and
 * `adoptUnderRecognizedRoot` (whose per-kind guard demands the full union) can
 * map over the tuple as-is. `mustHaveQuery` on the Observation-list pattern
 * keeps the two Observation kinds disjoint, so the order is not load-bearing;
 * it only fixes the sequence both surfaces route by.
 */
const unadopted: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  PatientResponseKind,
  ObservationResponseKind,
  ObservationListResponseKind,
]

const fhirR4ResponseKinds = unadopted.map(adoptUnderRecognizedRoot)

export { fhirR4ResponseKinds }
