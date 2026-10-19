import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import {
  AppIdPathSchema,
  AppListSchema,
  AppNotFoundSchema,
  InsufficientScopeSchema,
  LaunchTargetSchema,
} from './schemas.ts'

/**
 * Read + launch endpoints for the apps catalogue. This group carries no
 * middleware; the canonical (Rust) host scope-gates `ListApps` on
 * `wildflower/Apps.r` (a `403 InsufficientScope` when the token doesn't cover it)
 * and `LaunchApp` on the `wildflower/launch` umbrella — see
 * `docs/Apps/Explanation.md` §"Auth posture". The client attaches a bearer that a
 * gating host enforces and an ungated host ignores. The admin reads and mutations
 * live on `AppsAdminApi`.
 */
const httpApiGroup = HttpApiGroup.make('apps', { topLevel: false })
  .add(
    HttpApiEndpoint.get('ListApps', '/apps')
      .addSuccess(AppListSchema)
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    // `POST`: launching mutates server state (it mints a SMART app's launch
    // context). The host answers `200` with the launch URL
    // (`LaunchTargetSchema`), and the caller's page navigates there — a
    // redirect would be followed invisibly by `fetch` instead of moving the
    // tab.
    HttpApiEndpoint.post('LaunchApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(LaunchTargetSchema)
      .addError(AppNotFoundSchema, { status: 404 })
      // A token without the `wildflower/launch` umbrella comes back `403
      // InsufficientScope`.
      .addError(InsufficientScopeSchema, { status: 403 })
  )

export { httpApiGroup }
