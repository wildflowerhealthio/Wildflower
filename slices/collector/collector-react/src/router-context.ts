import { type CollectorHttpApiClient } from 'collector-core/clients'
import { type Layer } from 'effect'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildCollectorClientLayer } from './client/collector-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<CollectorHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<CollectorHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith`
 * narrowed to this slice's client. `awaitAuthReady` is inherited only
 * to keep this structural context a faithful subset of the host app's
 * `RouterContext`; collector loaders no longer read it — the gate
 * guarantees the token before the loader runs.
 */
type RouterContext = BaseRouterContext.RouterContextWith<CollectorHttpApiClient>

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
