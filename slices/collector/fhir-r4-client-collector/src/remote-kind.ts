import { type EntityDefinition, RemoteKind } from 'collector-fundamentals/model'
import type { Binary, Observation, Patient } from 'fhir-r4/resources'

import { ObservationEntity } from './entities/observation-entity.ts'
import { ObservationListEntity } from './entities/observation-list-entity.ts'
import { PatientEntity } from './entities/patient-entity.ts'

type AnyResource =
  | typeof Binary.Schema.Type
  | typeof Patient.Schema.Type
  | typeof Observation.Schema.Type

/**
 * Build a FHIR R4 `Remote` for a configured patient on a configured
 * server. The remote's `firstPage` is the inline bootstrap HTML
 * produced by {@link buildFhirBootstrapHtml}; its `entities` are the
 * three FHIR R4 entity definitions (`PatientEntity`,
 * `ObservationEntity`, `ObservationListEntity`).
 *
 * `onResult` is the caller's bridge between the dispatcher and the
 * wider sync — see `collector-react`'s `useSyncRunner` for the
 * concrete wiring (audit-log the raw body, route parsed resources
 * via `HttpApiClient(FhirResourcesApi)`).
 *
 * `config.rootUrl` and `config.patientId` are pre-validated by the
 * `InstanceConfig` schema (no trailing slashes; patientId is the FHIR
 * R4 logical-id grammar) — `encodeURIComponent` on `patientId` is
 * still applied defensively in case the value reaches this function
 * through an untyped path.
 */
const remoteKind = RemoteKind.make<AnyResource>({
  name: 'FHIR R4 Remote',
  entityDefinitions: [
    PatientEntity,
    ObservationEntity,
    ObservationListEntity,
  ] as readonly EntityDefinition.EntityDefinition<AnyResource>[],
})

export { remoteKind }
export type { AnyResource }
