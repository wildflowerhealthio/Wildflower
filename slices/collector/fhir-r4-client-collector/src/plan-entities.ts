import type { EntityDefinition } from 'collector-fundamentals/model'
import type { FhirResource } from 'fhir-r4/resources'

import { ObservationEntity } from './entities/observation-entity.ts'
import { ObservationListEntity } from './entities/observation-list-entity.ts'
import { PatientEntity } from './entities/patient-entity.ts'

/**
 * The three FHIR R4 entities in plan order — Patient, Observation,
 * Observation-list — as the single definition every consumer shares.
 *
 * @remarks
 * Both the live scraping plan's `entityDefinitions` (`./config.ts`) and the
 * offline `offlineEntities` surface (`./offline.ts`) adopt *this* tuple, so a
 * resource decodes identically whether it arrives through the sniffer or an
 * archive — the reuse the offline-surface ticket turns on. It lives in its own
 * module, rather than inline in the plan, so both consumers name the same
 * array without either importing the other's larger surface, and so the
 * reference the two share is unambiguous.
 *
 * The declared element type is the whole `FhirResource` union, which each
 * entity's narrower `EntityDefinition` satisfies by covariance — so no cast is
 * needed, and `adoptSourceIdentity` (whose guard demands the full union) can
 * wrap the tuple as-is. `mustHaveQuery` on the Observation-list pattern keeps
 * the two Observation entities disjoint, so the order is not load-bearing; it
 * only fixes the sequence both surfaces route by.
 */
const fhirR4EntityDefinitions: readonly EntityDefinition.EntityDefinition<FhirResource>[] = [
  PatientEntity,
  ObservationEntity,
  ObservationListEntity,
]

export { fhirR4EntityDefinitions }
