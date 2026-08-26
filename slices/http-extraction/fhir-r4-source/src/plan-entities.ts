import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { ObservationListResponseKind } from './response-kinds/observation-list-response-kind.ts'
import { ObservationResponseKind } from './response-kinds/observation-response-kind.ts'
import { PatientResponseKind } from './response-kinds/patient-response-kind.ts'

/**
 * The three FHIR R4 entities in plan order — Patient, Observation,
 * Observation-list — as the single definition every consumer shares.
 *
 * @remarks
 * Both this package's `fhirR4SourceEntities` (`./source-entities.ts`) and
 * the live scraping plan's response kinds (`fhir-r4-client-collector`'s
 * `config.ts`) adopt *this* tuple, so a resource decodes identically whether
 * it arrives through an archive or a sniffer. It lives in its own
 * module, rather than inline in the plan, so both consumers name the same
 * array without either importing the other's larger surface, and so the
 * reference the two share is unambiguous.
 *
 * The declared element type is the whole `FhirResource` union, which each
 * entity's narrower `HttpResponseKind` satisfies by covariance — so no cast is
 * needed, and `adoptSourceIdentity` (whose guard demands the full union) can
 * wrap the tuple as-is. `mustHaveQuery` on the Observation-list pattern keeps
 * the two Observation entities disjoint, so the order is not load-bearing; it
 * only fixes the sequence both surfaces route by.
 */
const fhirR4ResponseKinds: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = [
  PatientResponseKind,
  ObservationResponseKind,
  ObservationListResponseKind,
]

export { fhirR4ResponseKinds }
