import { type CollectorHttpApiClient } from 'collector-core/clients'
import { type Layer } from 'effect'
import { type FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildCollectorClientLayer } from './client/collector-client.ts'

/**
 * Extra services the collector router context layers on top of the
 * `BearerToken | HttpClient` floor. Beyond its own
 * {@link CollectorHttpApiClient}, the sync runner runs one long import
 * Effect whose forked per-resource FHIR writes require
 * {@link FhirR4ResourcesHttpApiClient}; that requirement bubbles up to
 * the long Effect's `R`, so `runAuthed` must satisfy it. The host app
 * provides this client via the FHIR slice's own layer — the collector
 * slice does not self-provide it (see {@link sliceRuntimeLayer}).
 */
type ExpectedClients = CollectorHttpApiClient | FhirR4ResourcesHttpApiClient

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<ExpectedClients>
type RunAuthed = BaseRouterContext.RunAuthedWith<ExpectedClients>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith`
 * narrowed to this slice's services. `awaitAuthReady` is inherited only
 * to keep this structural context a faithful subset of the host app's
 * `RouterContext`; collector loaders no longer read it — the gate
 * guarantees the token before the loader runs.
 */
type RouterContext = BaseRouterContext.RouterContextWith<ExpectedClients>

/**
 * The collector slice's client layer, ready for the app to merge into
 * its composed `runtimeLayer` over `BaseRouterContext.RuntimeLayer`
 * (`BearerToken | HttpClient`). Bearer-attaching per request — see
 * {@link buildCollectorClientLayer}.
 */
const sliceRuntimeLayer: Layer.Layer<
  CollectorHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildCollectorClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
