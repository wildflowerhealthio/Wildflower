//! `GET` / `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Both methods share one handler body ([`launch`]): the web arm is a native
//! `<a href="/apps/{id}">` the browser follows (a `GET`, so a plain click
//! navigates and a cmd/ctrl-click opens a new tab), while the loopback (Tauri)
//! arm drives the typed client's `POST`. A `GET` that mints a `{launch}` nonce
//! (and may bring the tunnel up) is intentional — a launch is a navigation, like
//! an OAuth `authorize`. See `docs/Apps/Explanation.md`.
//!
//! Two orthogonal axes meet here: the app's kind (its [`AppConfiguration`] variant)
//! fixes how the launch URL is *resolved*, while the *request's*
//! [`RequestProvenance`] (loopback vs. forwarded) fixes how it's *dispatched*. The
//! flow:
//!
//!   1. Read the request's [`RequestProvenance`] *once*, so an empty/spoofed
//!      `Forwarded` host can't make the gate-vs-resolve and which-origin
//!      decisions disagree.
//!   2. The `wildflower/launch` umbrella is enforced *before this handler runs* by
//!      the [`Scoped<LiveAppLauncher>`](crate::live_bindings::LiveAppLauncher) extractor
//!      (the host wraps the launch router with the bearer gate that inserts the
//!      caller's scope claims). An under-umbrella caller `403`s before `find_app`
//!      or target resolution, so it triggers no `tunnel.try_start()` and learns
//!      nothing about existence (`404`) or reachability (`503`). (This retired the
//!      former in-handler loopback owner gate.)
//!   3. Look up the app (`404 AppNotFound` if absent).
//!   4. Per-app SMART gate: a **SMART** app additionally requires the caller's
//!      grant to cover its OAuth client's requested *resource* scopes (the OIDC /
//!      launch-context scopes are the app's own OAuth concern, filtered out). A
//!      shortfall `403`s before any side-effect — JSON for the loopback/SPA arm, a
//!      plain-text response for a forwarded browser navigation. A non-SMART app
//!      needs only the umbrella.
//!   5. Resolve the launch target by the app's kind (System → compiled-in source,
//!      Self-Hosted → loopback/subdomain, Cloud → the stored template). Fails
//!      `503 LaunchUnavailable` when no *reachable* target exists.
//!   6. Dispatch on the request's provenance: a loopback launch `204`s after
//!      handing the URL to the host webview; a forwarded launch `302`s. A forwarded
//!      **self-hosted** launch additionally plants a `Set-Cookie` re-scoping the
//!      caller's owner session onto the app's public host — see
//!      [`crate::http::LaunchCookies`] and `docs/Apps/Explanation.md`.
//!
//! The auth posture (scope-gated on `wildflower/launch` + a per-app SMART check;
//! a forwarded launch rides the front trust boundary) is canonical in
//! `docs/Apps/Explanation.md` §"Auth posture".

use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::header::{CONTENT_TYPE, LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};
use scopes_rust::Scope;
use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};

use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, CloudAppConfiguration, LaunchParams,
    SelfHostedAppConfiguration, SystemAppConfiguration,
};
use crate::http::errors::{AppNotFoundBody, LaunchUnavailableBody};
use crate::id_utils::mint_launch_nonce;
use crate::live_bindings::state::AppsState;
use crate::live_bindings::LiveAppLauncher;

/// `POST /apps/{id}` — launch an app (`404` if no app has this id). The loopback
/// (Tauri) arm drives this through the typed client so the owner bearer rides
/// along. Scope-gated on the `wildflower/launch` umbrella through
/// [`Scoped<LiveAppLauncher>`]; a SMART app additionally requires the caller's grant
/// to cover its OAuth client's scopes (checked in [`launch`]). See the module docs
/// for the resolve-then-dispatch flow and the auth posture; the body is shared with
/// [`handle_launch_app_get`] via [`launch`].
#[utoipa::path(
    post,
    tag = "Launch",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "Host sink opened the launch URL for a loopback caller (no redirect)"),
        (status = 302, description = "Redirect (Location header) to the resolved launch URL"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/launch`, or a SMART app's required client scopes", body = InsufficientScopeBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 503, description = "No reachable launch target (forwarded launch with no public host, or a requires_tunnel app while the tunnel is down)", body = LaunchUnavailableBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    launcher: Scoped<LiveAppLauncher>,
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppsError> {
    launch(&launcher, state, headers, id).await
}

/// `GET /apps/{id}` — the web launch arm. A home-screen tile is a real
/// `<a href="/apps/{id}" rel="nofollow noreferrer">`, so a plain click navigates
/// the current tab and a cmd/ctrl-click opens a new one — native affordances a
/// form-`POST` or `fetch` can't preserve. The auth cookie rides the anchor
/// navigation (even the initial document request, before any JS), so a forwarded
/// `GET` authenticates and the server `302`s to the resolved target. Shares
/// [`launch`] with the `POST` arm — identical resolve-then-dispatch and auth
/// posture.
///
/// A *failed* `GET` (`403`/`404`/`503`) is rewritten to a `303` back to
/// `/home?launchError=<kind>` by [`redirect_browser_launch_errors`], so the browser
/// lands on the SPA's banner instead of the raw error body. The `4xx`/`5xx`
/// responses documented below are the handler's own (what the `POST` arm returns);
/// the browser arm never renders them.
#[utoipa::path(
    get,
    tag = "Launch",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "Host sink opened the launch URL for a loopback caller (no redirect)"),
        (status = 302, description = "Redirect (Location header) to the resolved launch URL"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/launch`, or a SMART app's required client scopes", body = InsufficientScopeBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 503, description = "No reachable launch target (forwarded launch with no public host, or a requires_tunnel app while the tunnel is down)", body = LaunchUnavailableBody),
    ),
)]
pub(crate) async fn handle_launch_app_get(
    launcher: Scoped<LiveAppLauncher>,
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppsError> {
    launch(&launcher, state, headers, id).await
}

/// The SPA route a failed **browser** launch bounces to; the home screen decodes
/// the `launchError` kind into a banner (see the apps-react `/home` route).
const LAUNCH_ERROR_HOME: &str = "/home";

/// The coarse `launchError` kind the home-screen banner switches on, by failure
/// status. Deliberately coarse — a browser navigation shouldn't leak the missing
/// scope or whether the app exists; the SPA maps each kind to a sentence.
fn launch_error_kind(status: StatusCode) -> &'static str {
    match status {
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::NOT_FOUND => "not-found",
        StatusCode::SERVICE_UNAVAILABLE => "unavailable",
        _ => "failed",
    }
}

/// A layer over the launch routes that bounces a **failed browser (`GET`) launch**
/// to `/home?launchError=<kind>` instead of letting the raw error body render as a
/// full page (the web arm is a native `<a href="/apps/{id}">` navigation, so a
/// `403`/`404`/`503` would otherwise paint its JSON/text body as the page).
///
/// Only a `GET` is rewritten, and only on an error status — a successful launch
/// (`302` to the app, or `204`) passes through untouched, and the typed loopback
/// `POST` arm (the SPA/Tauri client, which decodes the body) is never rewritten, so
/// it still sees the real status. Applied in
/// [`launch_openapi_router`](crate::http::routes::launch_openapi_router).
pub(crate) async fn redirect_browser_launch_errors(request: Request, next: Next) -> Response {
    let is_browser_get = request.method() == Method::GET;
    let response = next.run(request).await;
    let status = response.status();
    if !is_browser_get || !(status.is_client_error() || status.is_server_error()) {
        return response;
    }
    let location = format!(
        "{LAUNCH_ERROR_HOME}?launchError={}",
        launch_error_kind(status)
    );
    // `303 See Other`: the browser re-issues a `GET` to `/home` (dropping the failed
    // request's method + body). `location` is a static path plus a fixed kind, so
    // the header value is always valid ASCII.
    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(LOCATION, location)
        .body(axum::body::Body::empty())
        .expect("a static /home redirect is always a valid response")
}

/// The shared launch body for both `GET` and `POST /apps/{id}` — the method only
/// picks the arm (native anchor navigation vs. the typed loopback client); the
/// resolve-then-dispatch flow and auth posture are identical.
async fn launch(
    launcher: &LiveAppLauncher,
    state: Arc<AppsState>,
    headers: HeaderMap,
    id: String,
) -> Result<Response, AppsError> {
    // Read once (see module docs, step 1): a header that fails validation reads as
    // Loopback; a forwarded host that cleared validation but failed to parse as a
    // URL is an internal inconsistency, so 500 rather than guess.
    let Some(provenance) = request_provenance(&headers) else {
        return Err(AppsError::infrastructure(
            "request_provenance",
            "forwarded header did not indicate a valid base URL",
        ));
    };

    // The `wildflower/launch` umbrella has already been enforced by the
    // `Scoped<AppLauncher>` extractor (module docs, step 2) — retiring the former
    // in-handler loopback owner gate. An under-umbrella caller was `403`d before
    // this handler ran, so it triggered no lookup or side-effect.

    // 404 before resolving — an unknown id is never an availability failure. The
    // store hands back the `(registration, configuration)` pair; both halves feed
    // the kind-dispatched resolve below (no "combined app" — the tuple is the app).
    // Inlined `find_app` + `NotFound` (the same shape each admin read capability
    // inlines — there is no shared `get_app` helper) — the read's one launch caller.
    let (registration, configuration) = state
        .store
        .find_app(&id)?
        .ok_or_else(|| AppsError::NotFound { id: id.clone() })?;

    // Per-app SMART gate (module docs, step 4): a SMART app additionally requires
    // the caller's grant to cover its OAuth client's resource scopes (OIDC /
    // launch-context scopes are filtered out). A shortfall bails with a `403` shaped
    // for the caller's arm — JSON for the loopback/SPA caller, a plain-text response
    // for a forwarded browser navigation — before any side-effect. A non-SMART app
    // needs only the umbrella (short-circuited inside).
    let missing = launcher.missing_launch_scopes(&registration)?;
    if !missing.is_empty() {
        return Ok(insufficient_launch_scope(missing, &provenance));
    }

    // Resolve before dispatching: an unreachable target bails here with
    // `503 LaunchUnavailable` rather than opening a doomed popup / dead redirect.
    let resolved = resolve_launch(&registration, &configuration, &state, &provenance).await?;

    match &provenance {
        // The loopback caller cleared the umbrella + SMART gates above; hand the URL
        // to the host webview and `204` (the seam is contractually fire-and-forget).
        RequestProvenance::Loopback => {
            state
                .on_device_webview_handle
                .open(registration.name.clone(), resolved.target_url);
            Ok(no_content())
        }
        // A forwarded self-hosted launch re-scopes the caller's session onto its
        // public host (`session_cookie_host`); every other launch plants nothing.
        RequestProvenance::Forwarded { .. } => {
            let set_cookies = match &resolved.session_cookie_host {
                Some(host) => state.launch_cookies.rescope_for_host(&headers, host),
                None => Vec::new(),
            };
            redirect(resolved.target_url, set_cookies)
        }
    }
}

/// Render an under-scoped SMART launch as a `403` shaped for the caller's arm: a
/// loopback/SPA caller decodes the JSON `InsufficientScope` body (the same shape
/// the admin surface returns, via [`AppsError::InsufficientScope`]), while a
/// forwarded browser navigation gets a plain `text/plain` `403` rather than a JSON
/// body it would render as page text. (The umbrella-scope failure is handled
/// earlier by the `Scoped` extractor and always renders as JSON — a coarse gate an
/// authenticated launch-capable caller doesn't hit.)
fn insufficient_launch_scope(missing: Vec<Scope>, provenance: &RequestProvenance) -> Response {
    let missing_scopes = scopes_rust::render_scopes(&missing);
    match provenance {
        RequestProvenance::Loopback => {
            AppsError::InsufficientScope { missing_scopes }.into_response()
        }
        RequestProvenance::Forwarded { .. } => (
            StatusCode::FORBIDDEN,
            [(CONTENT_TYPE, "text/plain; charset=utf-8")],
            format!(
                "Insufficient scope to launch this app. Missing: {}",
                missing_scopes.join(" ")
            ),
        )
            .into_response(),
    }
}

/// A resolved launch: the provenance-aware `target_url` and — for a forwarded
/// self-hosted launch only — the public host to re-scope the caller's owner
/// session onto.
struct ResolvedLaunch {
    /// The provenance-aware launch URL (loopback origin, public subdomain, or a
    /// rendered cloud template).
    target_url: String,
    /// `Some(public_host)` for a **forwarded self-hosted** launch — the host to
    /// re-scope the caller's owner session onto (see [`crate::http::LaunchCookies`]).
    /// `None` for loopback, system, and cloud launches, which need no cookie.
    session_cookie_host: Option<String>,
}

/// Resolve an app (its `(registration, configuration)` pair) to a
/// [`ResolvedLaunch`], dispatching on the `configuration` kind — the whole app came
/// out of one store read, so the kind-specific launch data is already in hand (a
/// system app always carries a valid compiled-in source; a corrupt registry row
/// fails inside the store read as a typed error, never here). `session_cookie_host`
/// is `Some` only for a forwarded self-hosted launch. `503` if the matched app has
/// no reachable target.
///
/// Lives beside the launch handler rather than in `domain` on purpose: the
/// resolution reaches into `AppsState` (the tunnel, the loopback config) and yields
/// an http [`AppsError`], so keeping it in the HTTP layer leaves the domain free of
/// that http/runtime coupling.
async fn resolve_launch(
    registration: &AppRegistration,
    configuration: &AppConfiguration,
    state: &AppsState,
    provenance: &RequestProvenance,
) -> Result<ResolvedLaunch, AppsError> {
    match configuration {
        AppConfiguration::System(config) => Ok(ResolvedLaunch {
            target_url: render_system_target(state, config, provenance),
            session_cookie_host: None,
        }),
        AppConfiguration::SelfHosted(config) => {
            let SelfHostedTarget {
                target_url,
                session_cookie_host,
            } = render_self_hosted_target(config, state, provenance)?;
            Ok(ResolvedLaunch {
                target_url,
                session_cookie_host,
            })
        }
        AppConfiguration::Cloud(config) => Ok(ResolvedLaunch {
            target_url: render_cloud_target(state, provenance, registration, config).await?,
            session_cookie_host: None,
        }),
    }
}

/// Render a system app's launch target from its stored [`SystemAppConfiguration`]:
/// substitute `{origin}` (the served origin) + `{launch}` (a fresh nonce). The
/// `url` was validated at the store read (the [`AppUrl`](crate::domain::AppUrl)
/// column decode), so no parse can fail here.
fn render_system_target(
    state: &AppsState,
    config: &SystemAppConfiguration,
    provenance: &RequestProvenance,
) -> String {
    let origin = served_origin(state, provenance);
    let launch = mint_launch_nonce();
    config.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    })
}

/// A resolved self-hosted launch target: the provenance-aware URL plus, for a
/// forwarded launch only, the public host to re-scope the caller's owner session
/// onto. Named (rather than a `(String, Option<String>)` tuple) so the two strings
/// can't be transposed at the call site.
struct SelfHostedTarget {
    /// The launch URL — the loopback origin for a loopback caller, or the public
    /// subdomain for a forwarded one.
    target_url: String,
    /// `Some(public_host)` for a **forwarded** launch, whose cookie `Domain` this
    /// re-scopes to; `None` for a loopback launch.
    session_cookie_host: Option<String>,
}

/// Render a self-hosted app's launch target off its own origin — the loopback
/// `http://{host}:{port}/` for a loopback caller (no cookie host), else the public
/// subdomain ([`SelfHostedAppConfiguration::subdomain_url`], paired with the same
/// `public_host` so the cookie `Domain` can't drift from the redirect target). A
/// forwarded launch with **no** `public_host` configured has no reachable target,
/// so it `503 LaunchUnavailable`s rather than handing back loopback. Any
/// `launch_path` is applied by [`SelfHostedAppConfiguration::render_launch`].
fn render_self_hosted_target(
    config: &SelfHostedAppConfiguration,
    state: &AppsState,
    provenance: &RequestProvenance,
) -> Result<SelfHostedTarget, AppsError> {
    let (app_base, session_cookie_host) = match provenance {
        RequestProvenance::Forwarded { .. } => {
            let Some(public_host) = state.tunnel.current_public_host() else {
                return Err(AppsError::Unavailable {
                    reason: "no public host is configured for this remote launch".to_owned(),
                });
            };
            (config.subdomain_url(&public_host), Some(public_host))
        }
        RequestProvenance::Loopback => (config.local_launch_url(&state.loopback_hostname()), None),
    };
    let served = served_origin(state, provenance);
    let launch = mint_launch_nonce();
    Ok(SelfHostedTarget {
        target_url: config.render_launch(&app_base, &served, &launch),
        session_cookie_host,
    })
}

/// Render a cloud app's launch target: resolve the served origin (or the tunnel's
/// verified origin for a `requires_tunnel` launch), then substitute `{origin}` /
/// `{launch}` in the stored [`AppUrl`](crate::domain::AppUrl) template. Fails
/// `503 LaunchUnavailable` when a `requires_tunnel` launch can't bring the tunnel
/// up (see [`resolve_origin`]).
async fn render_cloud_target(
    state: &AppsState,
    provenance: &RequestProvenance,
    registration: &AppRegistration,
    config: &CloudAppConfiguration,
) -> Result<String, AppsError> {
    let origin = resolve_origin(state, provenance, registration.requires_tunnel).await?;
    let launch = mint_launch_nonce();
    Ok(config.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    }))
}

/// The served origin for a non-tunnel launch: the forwarded public origin when
/// the trusted front relayed the request, else loopback.
fn served_origin(state: &AppsState, provenance: &RequestProvenance) -> String {
    match provenance {
        RequestProvenance::Forwarded { base_url } => {
            shared_structures_rust::origin_string(base_url)
        }
        RequestProvenance::Loopback => state.loopback_origin(),
    }
}

/// Resolve the launch origin for a cloud app.
///
/// A non-tunnel launch resolves to the *served* origin (see [`served_origin`]) so
/// the `302`'s `Location` is something the caller can actually reach. A
/// `requires_tunnel` launch asks the `TunnelService` to start: `Ok(origin)` is the
/// live verified origin; `Err(reason)` means the tunnel couldn't be brought up —
/// and since the third-party app needs the tunnel to reach the user's FHIR server,
/// there is no reachable origin to fall back to, so the launch fails with
/// `503 LaunchUnavailable`.
async fn resolve_origin(
    state: &AppsState,
    provenance: &RequestProvenance,
    requires_tunnel: bool,
) -> Result<String, AppsError> {
    if !requires_tunnel {
        return Ok(served_origin(state, provenance));
    }
    state.tunnel.try_start().await.map_err(|reason| {
        tracing::warn!(%reason, "requires_tunnel launch failed: tunnel unavailable");
        AppsError::Unavailable { reason }
    })
}

/// 302 with an empty body, carrying each of `set_cookies` as a distinct
/// `Set-Cookie` (empty for every launch but a forwarded self-hosted one). The
/// `Content-Type` of `text/html; charset=utf-8` matches the TS contract
/// (`HttpApiSchema.Text`). A failure here means the rendered URL contained a byte
/// the header codec rejected; surfaces as a logged 500 (never a handler panic).
fn redirect(location: String, set_cookies: Vec<HeaderValue>) -> Result<Response, AppsError> {
    let mut builder = Response::builder()
        .status(StatusCode::FOUND)
        .header(LOCATION, &location)
        .header("content-type", "text/html; charset=utf-8");
    for cookie in set_cookies {
        builder = builder.header(SET_COOKIE, cookie);
    }
    builder
        .body(axum::body::Body::empty())
        .map_err(|e| AppsError::infrastructure("redirect builder failed", e))
}

/// 204 No Content — the response when the host's
/// [`OnDeviceWebviewHandle`](crate::OnDeviceWebviewHandle) has taken the launch.
fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}
