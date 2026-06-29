import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { AppIdPathSchema, AppListSchema, AppNotFoundSchema } from './schemas.ts'

/**
 * Read + launch endpoints for the apps catalogue. This group carries no
 * middleware; the canonical (Rust) host owner-gates `ListApps` and mounts
 * `LaunchApp` ungated (a forwarded launch rides the front trust boundary, a
 * loopback launch is owner-gated in-handler) — see `docs/Apps/Explanation.md`
 * §"Auth posture". The client attaches a bearer that a gating host enforces and
 * an ungated host ignores. The cloud-admin mutations live on `AppsAdminApi`.
 */
const httpApiGroup = HttpApiGroup.make('apps', { topLevel: false })
  .add(HttpApiEndpoint.get('ListApps', '/apps').addSuccess(AppListSchema))
  .add(
    // `POST` rather than `GET`: launching mutates host state (brings the tunnel
    // up, then 302s the browser or, on the Tauri host, opens a native popup and
    // 204s). The success body is never read through this typed client — the SPA
    // POSTs raw and follows the 302 — but the endpoint stays declared so the
    // spec-drift test keeps the path/method pinned against the Rust server.
    HttpApiEndpoint.post('LaunchApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' }))
      .addError(AppNotFoundSchema, { status: 404 })
  )

export { httpApiGroup }
