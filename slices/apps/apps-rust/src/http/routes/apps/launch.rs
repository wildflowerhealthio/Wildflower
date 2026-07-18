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
//!   2. Owner-gate a **loopback** request *before any lookup or side-effect*: an
//!      unauthorized loopback caller `401`s before `find_app` or target
//!      resolution, so it triggers no `tunnel.try_start()` and learns nothing
//!      about whether the id exists (`404`) or is reachable (`503`). A forwarded
//!      request skips the gate — the trusted front is its boundary.
//!   3. Look up the app (`404 AppNotFound` if absent).
//!   4. Resolve the launch target by the app's kind (System → compiled-in source,
//!      Self-Hosted → loopback/subdomain, Cloud → the stored template). Fails
//!      `503 LaunchUnavailable` when no *reachable* target exists.
//!   5. Dispatch on the request's provenance: a loopback launch `204`s after
//!      handing the (already owner-checked) URL to the host webview; a forwarded
//!      launch `302`s. A forwarded **self-hosted** launch additionally plants a
//!      `Set-Cookie` re-scoping the caller's owner session onto the app's public
//!      host — see [`crate::http::LaunchCookies`] and `docs/Apps/Explanation.md`.
//!
//! The auth posture (loopback owner-gated, forwarded on the front trust boundary)
//! is canonical in `docs/Apps/Explanation.md` §"Auth posture".

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::{LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};

use crate::domain::{
    actions, AppConfiguration, AppRegistration, AppsError, CloudAppConfiguration, LaunchParams,
    SelfHostedAppConfiguration, SystemAppConfiguration,
};
use crate::http::errors::{AppNotFoundBody, LaunchUnavailableBody};
use crate::id_utils::mint_launch_nonce;
use crate::state::AppsState;

/// `POST /apps/{id}` — launch an app (`404` if no app has this id). The loopback
/// (Tauri) arm drives this through the typed client so the owner bearer rides
/// along. See the module docs for the resolve-then-dispatch flow and the auth
/// posture; the body is shared with [`handle_launch_app_get`] via [`launch`].
#[utoipa::path(
    post,
    tag = "Launch",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "Host sink opened the launch URL for a loopback caller (no redirect)"),
        (status = 302, description = "Redirect (Location header) to the resolved launch URL"),
        (status = 401, description = "A loopback launch whose caller is not the device owner"),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 503, description = "No reachable launch target (forwarded launch with no public host, or a requires_tunnel app while the tunnel is down)", body = LaunchUnavailableBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppsError> {
    launch(state, headers, id).await
}

/// `GET /apps/{id}` — the web launch arm. A home-screen tile is a real
/// `<a href="/apps/{id}" rel="nofollow noreferrer">`, so a plain click navigates
/// the current tab and a cmd/ctrl-click opens a new one — native affordances a
/// form-`POST` or `fetch` can't preserve. The auth cookie rides the anchor
/// navigation (even the initial document request, before any JS), so a forwarded
/// `GET` authenticates and the server `302`s to the resolved target. Shares
/// [`launch`] with the `POST` arm — identical resolve-then-dispatch and auth
/// posture.
#[utoipa::path(
    get,
    tag = "Launch",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "Host sink opened the launch URL for a loopback caller (no redirect)"),
        (status = 302, description = "Redirect (Location header) to the resolved launch URL"),
        (status = 401, description = "A loopback launch whose caller is not the device owner"),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 503, description = "No reachable launch target (forwarded launch with no public host, or a requires_tunnel app while the tunnel is down)", body = LaunchUnavailableBody),
    ),
)]
pub(crate) async fn handle_launch_app_get(
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppsError> {
    launch(state, headers, id).await
}

/// The shared launch body for both `GET` and `POST /apps/{id}` — the method only
/// picks the arm (native anchor navigation vs. the typed loopback client); the
/// resolve-then-dispatch flow and auth posture are identical.
async fn launch(
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

    // Owner-gate a loopback request before any lookup or side-effect (module docs,
    // step 2): an unauthorized loopback caller must trigger no `tunnel.try_start()`
    // and must not learn whether the id exists (`404`) or is reachable (`503`).
    if matches!(provenance, RequestProvenance::Loopback)
        && !state
            .owner_auth
            .is_owner(&headers, &state.loopback_origin())
    {
        return Err(AppsError::Unauthorized);
    }

    // 404 before resolving — an unknown id is never an availability failure. The
    // store hands back the `(registration, configuration)` pair; both halves feed
    // the kind-dispatched resolve below (no "combined app" — the tuple is the app).
    let (registration, configuration) = actions::get_app(&state.store, &id)?;

    // Resolve before dispatching: an unreachable target bails here with
    // `503 LaunchUnavailable` rather than opening a doomed popup / dead redirect.
    let resolved = resolve_launch(&registration, &configuration, &state, &provenance).await?;

    match &provenance {
        // The loopback caller was owner-checked above; hand the URL to the host
        // webview and `204` (the seam is contractually fire-and-forget).
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
