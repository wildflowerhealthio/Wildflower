import { type AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { type BaseRouterContext } from '@wildflowerhealthio/shared-structures-react'
import { type Layer } from 'effect'

import { buildAuthorizationServerClientLayer } from './client/authorization-server-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<AuthorizationServerHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<AuthorizationServerHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith`
 * narrowed to this slice's client. `awaitAuthReady` is inherited only to keep
 * this structural context a faithful subset of the host app's `RouterContext`;
 * the authorization server loaders don't read it — the gate guarantees the
 * token before the loader runs.
 */
type RouterContext = BaseRouterContext.RouterContextWith<AuthorizationServerHttpApiClient>

/**
 * The authorization server slice's client layer, ready for the app to merge into
 * its composed `runtimeLayer` over `BaseRouterContext.RuntimeLayer`
 * (`HttpClient`). Tokenless — see {@link buildAuthorizationServerClientLayer}.
 */
const sliceRuntimeLayer: Layer.Layer<
  AuthorizationServerHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildAuthorizationServerClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
