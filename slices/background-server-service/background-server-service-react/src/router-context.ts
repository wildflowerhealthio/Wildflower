import type { BaseRouterContext } from 'shared-structures-react'

/**
 * Slice-local router context: the shared base, with no slice client — the
 * `/settings/server` page reads only the host's status snapshot, which arrives
 * over the bridge. A structural subset of `apps/wildflower-react`'s
 * `RouterContext`, re-declared here so the slice type-checks on its own.
 */
interface RouterContext extends BaseRouterContext.RouterContextWith<never> {}

export type { RouterContext }
