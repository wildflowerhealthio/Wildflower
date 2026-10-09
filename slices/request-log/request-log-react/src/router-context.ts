import { type Layer } from 'effect'
import type { RequestLogHttpApiClient } from 'request-log-core/clients'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildRequestLogClientLayer } from './client/request-log-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<RequestLogHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<RequestLogHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith` narrowed to
 * this slice's client. Kept a faithful subset of the host app's `RouterContext`
 * so the same route files type-check under both roots (the slice's standalone
 * `__root.tsx` and `apps/launcher/launcher-web`).
 */
type RouterContext = BaseRouterContext.RouterContextWith<RequestLogHttpApiClient>

const sliceRuntimeLayer: Layer.Layer<
  RequestLogHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildRequestLogClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
