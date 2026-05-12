import type * as EntityDefinition from 'collector-core/entity-definition'
import * as Remote from 'collector-core/remote'
import type { Binary, Observation, Patient } from 'emr-core/livestore'

import { buildFhirBootstrapHtml } from './bootstrap-fhir-page.ts'
import type { InstanceConfig } from './config.ts'
import { ObservationEntity } from './entities/observation-entity.ts'
import { ObservationListEntity } from './entities/observation-list-entity.ts'
import { PatientEntity } from './entities/patient-entity.ts'

type AnyResource =
  | typeof Binary.RowSchemaNullableId.Type
  | typeof Patient.RowSchemaNullableId.Type
  | typeof Observation.RowSchemaNullableId.Type

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
 */
const makeFhirR4Remote = (
  config: InstanceConfig,
  onResult: Remote.Config<AnyResource>['onResult']
): Remote.Remote => {
  const patientUrl = `${config.rootUrl}/Patient/${config.patientId}?_format=json`
  const observationUrl = `${config.rootUrl}/Observation?subject%3APatient=${config.patientId}&_count=250&_format=json`

  return Remote.make<AnyResource>({
    firstPage: { html: buildFhirBootstrapHtml({ patientUrl, observationUrl }) },
    name: 'FHIR R4 Remote',
    entities: [
      PatientEntity,
      ObservationEntity,
      ObservationListEntity,
    ] as readonly EntityDefinition.EntityDefinition<AnyResource>[],
    onResult,
  })
}

export { makeFhirR4Remote }
export type { AnyResource }
