import { HttpApi } from '@effect/platform'
import * as Remotes from './remotes.ts'

/**
 * Collector slice HTTP API — the remote-management endpoints
 * (`ListRemotes`, `GetRemote`, `CreateRemote`, `UpdateRemote`,
 * `DeleteRemote`).
 *
 * ⚠️ **All endpoints expose owner-only data and MUST be gated behind
 * `RequireAuthMiddleware` at the composition site.** The slice does
 * not annotate the group with `.middleware(RequireAuthMiddleware)`
 * directly because `gatekeeper-core` isn't an intrinsic dep of
 * `collector-core` — adding it here would cross the slice-layering
 * boundary in `slices/AGENTS.md`. The wildflower-server composition
 * applies the middleware via
 * `.addHttpApi(CollectorApi.middleware(RequireAuthMiddleware))`; a
 * compile-time regression guard lives in
 * `apps/wildflower-server/tests/auth-middleware-contract.test.ts`.
 *
 * Future composers of this API in another app surface MUST repeat the
 * `.middleware(RequireAuthMiddleware)` wrapper or write endpoints will
 * silently expose to unauthenticated clients.
 */
const CollectorApi = HttpApi.make('CollectorApi').add(Remotes.httpApiGroup)

export { CollectorApi, Remotes }
