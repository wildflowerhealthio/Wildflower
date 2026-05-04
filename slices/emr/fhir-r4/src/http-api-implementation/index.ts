import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'

import type { LivestoreStore } from 'emr-core/contexts'
import { FhirPublicApi, FhirResourcesApi } from '../http-api-definition/index.ts'
import {
  SmartConfiguration as SmartConfigurationTag,
  SmartConfigurationLive,
  makeSmartConfiguration,
} from '../internal/smart-configuration-context.ts'
import * as Binary from './binary.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'
import * as SmartConfiguration from './smart-configuration.ts'

const FhirResourcesApiHandlersLive = Layer.mergeAll(Patient.layer, Binary.layer, Observation.layer)

const FhirResourcesApiLive = HttpApiBuilder.api(FhirResourcesApi).pipe(
  Layer.provide(FhirResourcesApiHandlersLive)
)

type FhirResourcesGroupNames = 'Patient' | 'Binary' | 'Observation'

const FhirResourcesApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, FhirResourcesGroupNames>,
  never,
  LivestoreStore
> =>
  // The phantom-id bridge: `ApiGroup<ApiId, Name>` is a structural marker
  // with no runtime presence (HttpApiBuilder.group only registers routes on
  // the shared Router; nothing reads `apiId`), so a Layer built against
  // FhirResourcesApi is sound to satisfy the same group requirement under
  // any consumer's parent ApiId. This cast is the one place that bridge
  // lives for the FHIR resource side.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  FhirResourcesApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, FhirResourcesGroupNames>,
    never,
    LivestoreStore
  >

const FhirPublicApiHandlersLive = Layer.mergeAll(SmartConfiguration.layer)

const FhirPublicApiLive = HttpApiBuilder.api(FhirPublicApi).pipe(
  Layer.provide(FhirPublicApiHandlersLive),
  Layer.provide(SmartConfigurationLive)
)

type FhirPublicGroupNames = 'smart-well-known'

const FhirPublicApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, FhirPublicGroupNames>,
  never,
  SmartConfigurationTag
> =>
  // Phantom-id bridge — same rationale as FhirResourcesApiHandlersFor.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  FhirPublicApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, FhirPublicGroupNames>,
    never,
    SmartConfigurationTag
  >

export {
  Binary,
  Observation,
  Patient,
  SmartConfiguration,
  SmartConfigurationTag,
  SmartConfigurationLive,
  makeSmartConfiguration,
  FhirResourcesApiHandlersLive,
  FhirResourcesApiHandlersFor,
  FhirResourcesApiLive,
  FhirPublicApiHandlersLive,
  FhirPublicApiHandlersFor,
  FhirPublicApiLive,
}
