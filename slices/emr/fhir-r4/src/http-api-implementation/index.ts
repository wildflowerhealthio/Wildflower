import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'

import type { EmrStore } from 'emr-core/livestore'
import type { Origin } from 'navigation-core'
import { FhirResourcesApi } from '../http-api-definition/index.ts'
import * as Binary from './binary.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'

const FhirResourcesApiHandlersLive = Layer.mergeAll(Patient.layer, Binary.layer, Observation.layer)

const FhirResourcesApiLive = HttpApiBuilder.api(FhirResourcesApi).pipe(
  Layer.provide(FhirResourcesApiHandlersLive)
)

type FhirResourcesGroupNames = 'Patient' | 'Binary' | 'Observation'

const FhirResourcesApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, FhirResourcesGroupNames>,
  never,
  EmrStore | Origin
> =>
  // The phantom-id bridge: `ApiGroup<ApiId, Name>` is a structural marker
  // with no runtime presence (HttpApiBuilder.group only registers routes on
  // the shared Router; nothing reads `apiId`), so a Layer built against
  // FhirResourcesApi is sound to satisfy the same group requirement under
  // any consumer's parent ApiId. This cast bridges the API-id phantom only.
  //
  // The `satisfies` clause pins the source layer's actual shape — provided
  // group, error channel, and required services — against what we're about
  // to widen. If a handler grows a new requirement (e.g. when `Origin` got
  // added), this fails to compile before the `as unknown as` masks it. The
  // cast that follows only widens the API-id phantom; everything else flows
  // through unchanged.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  FhirResourcesApiHandlersLive satisfies Layer.Layer<
    HttpApiGroup.ApiGroup<'FhirResourcesApi', FhirResourcesGroupNames>,
    never,
    EmrStore | Origin
  > as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, FhirResourcesGroupNames>,
    never,
    EmrStore | Origin
  >

export {
  Binary,
  Observation,
  Patient,
  FhirResourcesApiHandlersLive,
  FhirResourcesApiHandlersFor,
  FhirResourcesApiLive,
}
