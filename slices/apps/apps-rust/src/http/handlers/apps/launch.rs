//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Two orthogonal axes meet here: the parent registry row's
//! [`Provenance`](crate::domain::Provenance) fixes how the launch URL is
//! *resolved*, while the *request's* [`RequestProvenance`] (loopback vs.
//! forwarded) fixes how it's *dispatched*. The flow:
//!
//!   1. Read the request's [`RequestProvenance`] *once*, so an empty/spoofed
//!      `Forwarded` host can't make the gate-vs-resolve and which-origin
//!      decisions disagree.
//!   2. Owner-gate a **loopback** request *before any lookup or side-effect*: an
//!      unauthorized loopback caller `401`s before `find_app` or target
//!      resolution, so it triggers no `tunnel.try_start()` and learns nothing
//!      about whether the id exists (`404`) or is reachable (`503`). A forwarded
//!      request skips the gate — the trusted front is its boundary.
//!   3. Look up the parent registry row (`404 AppNotFound` if absent).
//!   4. Resolve the launch target by the app's provenance (System → compiled-in
//!      source, Self-Hosted → loopback/subdomain, Cloud → the stored template).
//!      Fails `503 LaunchUnavailable` when no *reachable* target exists.
//!   5. Dispatch on the request's provenance: a loopback launch `204`s after
//!      handing the (already owner-checked) URL to the host webview; a forwarded
//!      launch `302`s. A forwarded **self-hosted** launch additionally plants a
//!      `Set-Cookie` re-scoping the caller's owner session onto the app's public
//!      host (see [`crate::http::LaunchCookies`]): the app is served at its own
//!      subdomain `<id>.<public_host>`, which the host-only `wf_auth` never
//!      reaches, so without this the app's origin would carry no session.
//!
//! The auth posture (loopback owner-gated, forwarded on the front trust
//! boundary) is canonical in `docs/Apps/Explanation.md` §"Auth posture"; the
//! forwarded `<id>.<public_host>` subdomain dispatch in
//! `docs/Origins/Explanation.md`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::{LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};

use crate::domain::{App, AppEntry, LaunchParams, Provenance, SelfHostedApp};
use crate::http::response_templates::{AppNotFoundBody, HandlerError, LaunchUnavailableBody};
use crate::http::state::AppsState;
use crate::id::mint_launch_nonce;

/// `POST /apps/{id}` — launch an app (`404` if no app has this id). See the
/// module docs for the resolve-then-dispatch flow and the auth posture.
#[utoipa::path(
    post,
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
) -> Result<Response, HandlerError> {
    // Read once (see module docs, step 1): a header that fails validation reads
    // as Loopback; a forwarded host that cleared validation but failed to parse
    // as a URL is an internal inconsistency, so 500 rather than guess.
    let Some(provenance) = request_provenance(&headers) else {
        return Err(HandlerError::internal(
            "request_provenance",
            "forwarded header did not indicate a valid base URL",
        ));
    };

    // Owner-gate a loopback request before any lookup or side-effect (module docs,
    // step 2): an unauthorized loopback caller must trigger no `tunnel.try_start()`
    // and must not learn whether the id exists (`404`) or is reachable (`503`). The
    // header-derived `Loopback` is gated in tandem with the host's network-layer
    // loopback-peer gate. A forwarded request rides the front trust boundary.
    if matches!(provenance, RequestProvenance::Loopback)
        && !state
            .owner_auth
            .is_owner(&headers, &state.loopback_origin())
    {
        return Err(HandlerError::Unauthorized);
    }

    // 404 before resolving — an unknown id is never an availability failure.
    let app = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

    // Resolve before dispatching: an unreachable target bails here with
    // `503 LaunchUnavailable` rather than opening a doomed popup / dead redirect.
    let resolved = resolve_launch_target(&state, &app, &provenance).await?;

    match &provenance {
        // The loopback caller was owner-checked above; hand the URL to the host
        // webview and `204` (the seam is contractually fire-and-forget).
        RequestProvenance::Loopback => {
            state
                .on_device_webview_handle
                .open(resolved.name, resolved.target_url);
            Ok(no_content())
        }
        // A forwarded self-hosted launch redirects the browser to the app's own
        // subdomain; re-scope the caller's session onto its public host so the
        // app's origin carries auth (the host-only `wf_auth` can't reach it).
        // Every other forwarded launch carries no `session_cookie_host`, so it
        // plants nothing.
        RequestProvenance::Forwarded { .. } => {
            let set_cookies = match &resolved.session_cookie_host {
                Some(host) => state.launch_cookies.rescope_for_host(&headers, host),
                None => Vec::new(),
            };
            redirect(resolved.target_url, set_cookies)
        }
    }
}

/// A resolved launch: the display `name` (loopback popup chrome only), the
/// provenance-aware `target_url`, and — for a forwarded self-hosted launch only —
/// the public host to re-scope the caller's owner session cookies onto.
struct ResolvedLaunch {
    /// The launched app's display name, used only to title the loopback popup.
    name: String,
    /// The provenance-aware launch URL (loopback origin, public subdomain, or a
    /// rendered cloud template).
    target_url: String,
    /// `Some(public_host)` for a **forwarded self-hosted** launch, whose `302`
    /// redirects the browser to `https://<subdomain>.<public_host>/`. The
    /// host-only `wf_auth` never rides to that subdomain, so the handler plants a
    /// `Domain=<public_host>` re-scope of the caller's session on the redirect
    /// (see [`crate::http::LaunchCookies`]). `None` for loopback, system, and
    /// cloud launches, which need no such cookie.
    session_cookie_host: Option<String>,
}

/// Resolve `app` to a [`ResolvedLaunch`], dispatching on the parent row's
/// [`Provenance`]. The name is only for the loopback popup's chrome; the launch
/// URL is the provenance-aware target; `session_cookie_host` is `Some` only for a
/// forwarded self-hosted launch. `503` if the matched app has no reachable
/// target; `500` for a `system` row with no compiled-in source.
async fn resolve_launch_target(
    state: &AppsState,
    app: &App,
    provenance: &RequestProvenance,
) -> Result<ResolvedLaunch, HandlerError> {
    match app.provenance {
        Provenance::System => {
            let target_url = render_system_target(state, app, provenance)?;
            Ok(ResolvedLaunch {
                name: app.name.clone(),
                target_url,
                session_cookie_host: None,
            })
        }
        Provenance::SelfHosted => {
            let child = state
                .store
                .find_self_hosted_app(&app.id)
                .map_err(|e| HandlerError::internal("self_hosted_apps find lookup failed", e))?
                .ok_or_else(|| {
                    // A `self-hosted` parent with no child row is a seed/schema
                    // inconsistency, not a client error — surface it as a logged
                    // 500 rather than a 404 (the parent exists).
                    HandlerError::internal(
                        "self-hosted parent has no child row",
                        format!("id={}", app.id),
                    )
                })?;
            let SelfHostedTarget {
                target_url,
                session_cookie_host,
            } = render_self_hosted_target(&child, state, provenance)?;
            Ok(ResolvedLaunch {
                name: app.name.clone(),
                target_url,
                session_cookie_host,
            })
        }
        Provenance::Cloud => {
            let entry = state
                .store
                .find_cloud_app(&app.id)
                .map_err(|e| HandlerError::internal("find_cloud_app lookup failed", e))?
                .ok_or_else(|| {
                    HandlerError::internal(
                        "cloud parent has no child row",
                        format!("id={}", app.id),
                    )
                })?;
            let target_url = render_cloud_target(state, provenance, &entry).await?;
            Ok(ResolvedLaunch {
                name: app.name.clone(),
                target_url,
                session_cookie_host: None,
            })
        }
    }
}

/// Render a system app's launch target from its compiled-in
/// [`SystemApp`](crate::domain::system_app) source: substitute `{origin}` (the
/// served origin) + `{launch}` (a fresh nonce). A seeded `system` id with no
/// matching source surfaces as a logged 500 rather than a panic.
fn render_system_target(
    state: &AppsState,
    app: &App,
    provenance: &RequestProvenance,
) -> Result<String, HandlerError> {
    let source = crate::domain::system_app::find(&app.id).ok_or_else(|| {
        // A seeded system row with no compiled-in source is a code/seed drift —
        // log it; never panic in the launch path.
        HandlerError::internal(
            "system app has no compiled-in source",
            format!("id={}", app.id),
        )
    })?;
    let url = source
        .app_url()
        .map_err(|e| HandlerError::internal("system app url failed to parse", e))?;
    let origin = served_origin(state, provenance);
    let launch = mint_launch_nonce();
    Ok(url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    }))
}

/// A resolved self-hosted launch target: the provenance-aware URL plus, for a
/// forwarded launch only, the public host to re-scope the caller's owner session
/// onto. Named (rather than a `(String, Option<String>)` tuple) so the two
/// strings can't be transposed at the call site.
struct SelfHostedTarget {
    /// The launch URL — the loopback origin for a loopback caller, or the public
    /// subdomain for a forwarded one.
    target_url: String,
    /// `Some(public_host)` for a **forwarded** launch, whose cookie `Domain` this
    /// re-scopes to; `None` for a loopback launch (which shares the `127.0.0.1`
    /// cookie and needs no re-scope).
    session_cookie_host: Option<String>,
}

/// Render a self-hosted app's launch target plus, for a forwarded launch, the
/// public host to re-scope the caller's owner session onto. A loopback caller
/// gets the loopback `http://{host}:{port}/` and `None` (the app shares the
/// `127.0.0.1` cookie already, and the desktop webview authenticates on
/// connection provenance). A forwarded caller gets the public subdomain (see
/// [`SelfHostedApp::subdomain_url`] and `docs/Origins/Explanation.md`) paired with
/// its `public_host` — the same value that built the subdomain URL, so the cookie
/// `Domain` can't drift from the redirect target. A forwarded launch with **no**
/// `public_host` configured has no reachable target, so it fails
/// `503 LaunchUnavailable` rather than handing back loopback.
fn render_self_hosted_target(
    child: &SelfHostedApp,
    state: &AppsState,
    provenance: &RequestProvenance,
) -> Result<SelfHostedTarget, HandlerError> {
    if matches!(provenance, RequestProvenance::Forwarded { .. }) {
        let Some(public_host) = state.tunnel.current_public_host() else {
            return Err(HandlerError::Unavailable {
                reason: "no public host is configured for this remote launch".to_owned(),
            });
        };
        return Ok(SelfHostedTarget {
            target_url: child.subdomain_url(&public_host),
            session_cookie_host: Some(public_host),
        });
    }
    Ok(SelfHostedTarget {
        target_url: child.launch_url(&state.loopback_hostname()),
        session_cookie_host: None,
    })
}

/// Render a cloud app's launch target: resolve the served origin (or the
/// tunnel's verified origin for a `requires_tunnel` launch), then substitute
/// `{origin}` / `{launch}` in the stored [`AppUrl`](crate::domain::AppUrl)
/// template. Fails `503 LaunchUnavailable` when a `requires_tunnel` launch can't
/// bring the tunnel up (see [`resolve_origin`]).
async fn render_cloud_target(
    state: &AppsState,
    provenance: &RequestProvenance,
    app: &AppEntry,
) -> Result<String, HandlerError> {
    let origin = resolve_origin(state, provenance, app.requires_tunnel).await?;
    let launch = mint_launch_nonce();
    Ok(app.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    }))
}

/// The served origin for a non-tunnel launch: the forwarded public origin when
/// the trusted front relayed the request, else loopback.
fn served_origin(state: &AppsState, provenance: &RequestProvenance) -> String {
    match provenance {
        RequestProvenance::Forwarded { base_url } => base_url.origin().ascii_serialization(),
        RequestProvenance::Loopback => state.loopback_origin(),
    }
}

/// Resolve the launch origin for a cloud app.
///
/// A non-tunnel launch resolves to the *served* origin (see [`served_origin`])
/// so the `302`'s `Location` is something the caller can actually reach. A
/// `requires_tunnel` launch asks the `TunnelService` to start: `Ok(origin)` is
/// the live verified origin; `Err(reason)` means the tunnel couldn't be brought
/// up — and since the third-party app needs the tunnel to reach the user's FHIR
/// server, there is no reachable origin to fall back to, so the launch fails with
/// `503 LaunchUnavailable` rather than pointing the app at an unreachable
/// loopback origin.
async fn resolve_origin(
    state: &AppsState,
    provenance: &RequestProvenance,
    requires_tunnel: bool,
) -> Result<String, HandlerError> {
    if !requires_tunnel {
        return Ok(served_origin(state, provenance));
    }
    state.tunnel.try_start().await.map_err(|reason| {
        // The reason distinguishes "no relay configured" from "dial timed out"
        // from "daemon stopped" — log it so an unavailable launch is diagnosable,
        // and carry it into the 503 body for the SPA.
        tracing::warn!(%reason, "requires_tunnel launch failed: tunnel unavailable");
        HandlerError::Unavailable { reason }
    })
}

/// 302 with an empty body, carrying each of `set_cookies` as a distinct
/// `Set-Cookie` (empty for every launch but a forwarded self-hosted one, which
/// re-scopes the caller's session onto the app's subdomain). The `Content-Type`
/// of `text/html; charset=utf-8` matches the TS contract (`HttpApiSchema.Text`).
/// A failure here means the rendered URL contained a byte the header codec
/// rejected; surfaces as a logged 500 (never a handler panic).
fn redirect(location: String, set_cookies: Vec<HeaderValue>) -> Result<Response, HandlerError> {
    let mut builder = Response::builder()
        .status(StatusCode::FOUND)
        .header(LOCATION, &location)
        .header("content-type", "text/html; charset=utf-8");
    for cookie in set_cookies {
        builder = builder.header(SET_COOKIE, cookie);
    }
    builder
        .body(axum::body::Body::empty())
        .map_err(|e| HandlerError::internal("redirect builder failed", e))
}

/// 204 No Content — the response when the host's
/// [`OnDeviceWebviewHandle`](crate::OnDeviceWebviewHandle) has taken the launch
/// (the host opened the URL; there's nothing for the SPA to follow).
fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}
