import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'

import type { EmrStore } from 'emr-core/contexts'
import type { Origin } from 'navigation-core'
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
  // Phantom-id bridge — same rationale as FhirResourcesApiHandlersFor; the
  // `satisfies` clause pins the source layer's actual shape so a new
  // requirement on `SmartConfiguration.layer` fails to compile before the
  // cast widens the API-id phantom. Consumers composing this with the bare
  // `*HandlersFor` helper must also provide `SmartConfigurationLive` (which
  // itself requires `Origin`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  FhirPublicApiHandlersLive satisfies Layer.Layer<
    HttpApiGroup.ApiGroup<'FhirPublicApi', FhirPublicGroupNames>,
    never,
    SmartConfigurationTag
  > as unknown as Layer.Layer<
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
