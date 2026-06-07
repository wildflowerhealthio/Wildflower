import { HttpApiError } from '@effect/platform'
import { Effect } from 'effect'
import { domainResources, EmrStore, Patient as StorePatient } from 'emr-core/livestore'
import { Commit } from 'emr-core/telemetry'

import { makeDomainResourceHandlerLayer } from '../internal/domain-resource-http-api-implementation.ts'
import { Patient } from '../resources/patient/index.ts'
import {
  buildWhere as buildPatientWhere,
  SearchParams as PatientSearchParams,
} from '../resources/patient/search-params.ts'

const layer = makeDomainResourceHandlerLayer(
  'Patient',
  StorePatient.RowSchemaNullableId,
  Patient.Schema,
  { SearchParams: PatientSearchParams, buildWhere: buildPatientWhere },
  {
    commitUpsert: (resource) =>
      Effect.flatMap(EmrStore, (store) =>
        Effect.try({
          try: () =>
            store.commit(
              { label: Commit.Upsert(domainResources.Patient.resourceType), skipRefresh: true },
              domainResources.Patient.events.upsert({ resource })
            ),
          catch: () => new HttpApiError.ServiceUnavailable(),
        })
      ),
    queryGetById$: domainResources.Patient.queries.getById$,
    querySearch$: domainResources.Patient.queries.search$,
    queryCount$: domainResources.Patient.queries.count$,
    // $everything: include Observations whose `subject.reference` matches
    // `Patient/{id}`. Filtering happens in memory because the `subject` JSON
    // column has no indexed sub-field; `_count` caps the returned slice.
    getRelated: ({ id, limit }) =>
      Effect.flatMap(EmrStore, (store) =>
        Effect.try({
          try: () => store.query(domainResources.Observation.queries.search$({})),
          catch: () => new HttpApiError.ServiceUnavailable(),
        }).pipe(
          Effect.map((rows) => {
            const expected = `Patient/${id}`
            const matches = rows.filter((row) => row.subject?.reference === expected)
            if (limit === undefined) {
              return matches
            }
            return matches.slice(0, limit)
          })
        )
      ),
  }
)

export { layer }
