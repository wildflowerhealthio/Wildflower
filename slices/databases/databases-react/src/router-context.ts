import type { DatabasesHttpApiClient } from 'databases-core/clients'
import { type Layer } from 'effect'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildDatabasesClientLayer } from './client/databases-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<DatabasesHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<DatabasesHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith` narrowed to
 * this slice's client. Kept a faithful subset of the host app's `RouterContext`
 * so the same route files type-check under both roots (the slice's standalone
 * `__root.tsx` and `apps/wildflower-react`).
 */
type RouterContext = BaseRouterContext.RouterContextWith<DatabasesHttpApiClient>

const sliceRuntimeLayer: Layer.Layer<
  DatabasesHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildDatabasesClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
