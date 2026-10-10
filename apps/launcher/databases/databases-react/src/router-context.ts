import type { DatabasesHttpApiClient } from '@wildflowerhealthio/databases-core-js/clients'
import { type BaseRouterContext } from '@wildflowerhealthio/shared-structures-react'
import { type Layer } from 'effect'

import { buildDatabasesClientLayer } from './client/databases-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<DatabasesHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<DatabasesHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith` narrowed to
 * this slice's client. Kept a faithful subset of the host app's `RouterContext`
 * so the same route files type-check under both roots (the slice's standalone
 * `__root.tsx` and `apps/launcher/launcher-web`).
 */
type RouterContext = BaseRouterContext.RouterContextWith<DatabasesHttpApiClient>

const sliceRuntimeLayer: Layer.Layer<
  DatabasesHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildDatabasesClientLayer()

export { sliceRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
