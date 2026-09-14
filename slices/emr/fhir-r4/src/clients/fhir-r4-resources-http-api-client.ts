import type { HttpApi, HttpApiClient, HttpApiError, HttpClient } from '@effect/platform'
import { Context, type Layer } from 'effect'
import { defineSliceHttpClient } from 'shared-structures-core/http-api-definition'

import { FhirResourcesApi } from '../http-api-definition/index.ts'

const sliceClient = defineSliceHttpClient({
  name: 'FhirR4ResourcesHttpApiClient',
  api: FhirResourcesApi,
})

// ── DTS serialization workaround ──────────────────────────────────────
//
// `sliceClient.ClientTag<Self>()` infers its base-class shape from the
// 11-group `FhirResourcesApi`. tsgo expands that shape inline when
// emitting the `.d.ts`, exceeding its serialization limit (TS7056).
//
// Fix: give the shape a **named interface** that tsgo references by name
// rather than expanding, then wire `Context.Tag` directly.
//
type _Groups =
  typeof FhirResourcesApi extends HttpApi.HttpApi<infer _Id, infer G, infer _E, infer _R>
    ? G
    : never

interface FhirR4ResourcesClientShape extends HttpApiClient.Client<
  _Groups,
  HttpApiError.HttpApiDecodeError,
  never
> {}

/**
 * Effect Service providing the resolved `FhirResourcesApi` HttpApi
 * client. `fhir-r4-react` builds its layer via
 * `buildFhirR4ResourcesClientLayer()` and the host app composes it into
 * the shared `runtimeLayer` (mirrors `GatekeeperHttpApiClient` from
 * `gatekeeper-core/clients`); call sites consume it Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(FhirR4ResourcesHttpApiClient, (c) =>
 *   c['patient'].CreatePatient({ payload })
 * )
 * ```
 */
class FhirR4ResourcesHttpApiClient extends Context.Tag('FhirR4ResourcesHttpApiClient')<
  FhirR4ResourcesHttpApiClient,
  FhirR4ResourcesClientShape
>() {
  static readonly layer: Layer.Layer<FhirR4ResourcesHttpApiClient, never, HttpClient.HttpClient> =
    sliceClient.makeLayerFactory(FhirR4ResourcesHttpApiClient)()
}

type FhirR4ResourcesHttpApiClientShape = typeof FhirR4ResourcesHttpApiClient.Service

export {
  FhirR4ResourcesHttpApiClient,
  type FhirR4ResourcesClientShape,
  type FhirR4ResourcesHttpApiClientShape,
}
