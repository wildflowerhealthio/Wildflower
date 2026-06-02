import { type Layer } from 'effect'
import { type BaseRouterContext } from 'shared-structures-react'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { buildTunnelAdminClientLayer } from './client/tunnel-client'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<TunnelAdminHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<TunnelAdminHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith`
 * narrowed to this slice's client. `awaitAuthReady` is inherited only
 * to keep this structural context a faithful subset of the host app's
 * `RouterContext`; the tunnel settings loader no longer reads it — the
 * gate guarantees the token before the loader runs.
 */
type RouterContext = BaseRouterContext.RouterContextWith<TunnelAdminHttpApiClient>

const sliceRuntimeLayer: Layer.Layer<
  TunnelAdminHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildTunnelAdminClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
