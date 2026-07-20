import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import {
  AppIdPathSchema,
  AppListSchema,
  AppNotFoundSchema,
  InsufficientScopeSchema,
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
    // (The Rust server also answers `403 InsufficientScope`/`503`, modelled only on
    // its side; the drift test exempts this endpoint's responses and pins only the
    // path/method.)
    HttpApiEndpoint.post('LaunchApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' }), { status: 302 })
      .addSuccess(HttpApiSchema.NoContent)
      .addError(AppNotFoundSchema, { status: 404 })
  )
  .add(
    // `GET /apps/:id`: the native web launch arm. The home-screen tile is a real
    // `<a href="/apps/:id">`, so a plain click navigates the current tab and a
    // cmd/ctrl-click opens a new one — affordances a form-`POST`/`fetch` can't
    // preserve. The auth cookie rides the anchor navigation (even the initial
    // document request, before any JS), so a forwarded `GET` authenticates and
    // the server `302`s to the resolved target.
    //
    // Modelled here for spec symmetry with the Rust host and the committed
    // OpenAPI snapshot, but **no typed client calls it**: the web arm is a
    // browser navigation the SPA never issues, and the loopback (Tauri) arm
    // drives the `POST` above. The success shape mirrors `LaunchApp` — the `302`
    // `Text` body first (so it replaces the default `NoContent`), then
    // `NoContent` (204) unions back in; the drift test pins the path/method and
    // exempts the (browser-only, non-JSON) responses just as it does for `POST`.
    HttpApiEndpoint.get('LaunchAppGet', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' }), { status: 302 })
      .addSuccess(HttpApiSchema.NoContent)
      .addError(AppNotFoundSchema, { status: 404 })
  )

export { httpApiGroup }
