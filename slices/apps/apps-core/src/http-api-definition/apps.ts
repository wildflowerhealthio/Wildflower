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
    // up). The host answers `204` for a loopback (Tauri) caller, after the native
    // popup is opened host-side, or `302` for a forwarded (web) caller — the
    // SPA's hidden form POSTs raw and the browser follows the redirect. The
    // loopback arm *does* drive this typed client (to carry the owner bearer), so
    // `204` must decode as success rather than fall through to the error path.
    //
    // Two subtleties force the shape below:
    //   * An endpoint's *default* success is `NoContent` (204), and the **first**
    //     `addSuccess` replaces that default rather than unioning with it — so the
    //     non-default `302` must come first, then `NoContent` (204) unions back in.
    //   * The `302` is given a `Text` body, not another empty (`Empty`/`NoContent`)
    //     success: two empty successes are both `Schema.Void` and their union
    //     collapses to a single status. The typed client never decodes the `302`
    //     (only the raw web form hits that path), so a loose `text/html` body —
    //     matching the host's redirect `Content-Type` — is harmless.
    // (The Rust server also answers `401`/`503`, modelled only on its side; the
    // drift test exempts this endpoint's responses and pins only the path/method.)
    HttpApiEndpoint.post('LaunchApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' }), { status: 302 })
      .addSuccess(HttpApiSchema.NoContent)
      .addError(AppNotFoundSchema, { status: 404 })
  )

export { httpApiGroup }
