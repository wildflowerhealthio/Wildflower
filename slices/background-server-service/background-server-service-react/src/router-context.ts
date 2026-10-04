import type { BaseRouterContext } from 'shared-structures-react'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

/**
 * Slice-local router context: `BaseRouterContext.RouterContextWith` narrowed
 * to the one client the `/settings/server` page reaches, the tunnel's (for
 * `GET /tunnel` while the server runs). A structural subset of
 * `apps/wildflower-react`'s `RouterContext`, re-declared here so the slice
 * type-checks on its own.
 */
type RouterContext = BaseRouterContext.RouterContextWith<TunnelAdminHttpApiClient>

/** The authed runner the tunnel's query runs through. */
type RunAuthed = RouterContext['runAuthed']

export type { RouterContext, RunAuthed }
