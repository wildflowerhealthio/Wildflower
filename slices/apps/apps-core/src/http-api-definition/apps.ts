import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
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
 * and mounts `LaunchApp` behind the launch scope gate (a forwarded launch rides
 * the front trust boundary; the per-app SMART check is in-handler) — see
 * `docs/Apps/Explanation.md` §"Auth posture". The client attaches a bearer that a
 * gating host enforces and an ungated host ignores. The cloud-admin mutations live
 * on `AppsAdminApi`.
 */
const httpApiGroup = HttpApiGroup.make('apps', { topLevel: false })
  .add(
    HttpApiEndpoint.get('ListApps', '/apps')
      .addSuccess(AppListSchema)
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    // `POST`: launching mutates host state (it can bring the tunnel up). The host
    // answers `204` for a loopback caller, after it opened the app in a native
    // popup, or `200` with the launch URL (`LaunchTargetSchema`) for a forwarded
    // caller, whose page then navigates there — a redirect would be followed
    // invisibly by `fetch` instead of moving the tab.
    //
    // An endpoint's *default* success is `NoContent` (204), and the **first**
    // `addSuccess` replaces that default rather than unioning with it — so the
    // `200` comes first, then `NoContent` (204) unions back in.
    // (The Rust server also answers `503`, modelled only on its side; the drift
    // test exempts this endpoint's responses and pins only the path/method.)
    HttpApiEndpoint.post('LaunchApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(LaunchTargetSchema)
      .addSuccess(HttpApiSchema.NoContent)
      .addError(AppNotFoundSchema, { status: 404 })
      // The launch umbrella / a SMART app's required scopes come back `403
      // InsufficientScope`; decode it (the home screen reads `missingScopes` to
      // route the permission banner).
      .addError(InsufficientScopeSchema, { status: 403 })
  )

export { httpApiGroup }
