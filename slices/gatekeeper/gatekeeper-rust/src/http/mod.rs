//! The gatekeeper's HTTP layer — everything axum-shaped lives under this
//! module. The only crate-facing surface is [`router`],
//! [`layer_router_with_gatekeeper_auth_gating`], and [`AppState`]; the handler
//! and middleware files are private implementation detail behind the route
//! table.

mod error_pages;
mod handlers;
mod middleware;
mod origin;
mod page_paths;
mod response_templates;
mod state;

pub(crate) use origin::ServedOrigin;
// Re-export the shared pure resolver so existing `crate::http::served_origin_for`
// imports keep working without leaking a `shared_structures_rust::` prefix into
// every middleware that calls it.
pub(crate) use shared_structures_rust::served_origin::served_origin_for;
pub use state::AppState;

use axum::middleware as axum_middleware;
use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

/// Base `OpenAPI` document; the collected routes fill in paths + components.
#[derive(OpenApi)]
struct ApiDoc;

/// The documented surface — jwks + the OAuth group — as an `OpenApiRouter`, so
/// the spec is collected from the very routes that serve traffic. Trial scope:
/// the `/access/*` admin surface is intentionally not documented.
fn documented_router() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(handlers::jwks::handle_jwks_request))
        .nest("/oauth", handlers::oauth::openapi_router())
}

/// Build the gatekeeper's public HTTP surface. Routes live at
/// `/.well-known/jwks.json`, `/oauth/*`, and `/access/*` (Owner-only via
/// bearer JWT) — the module owns its mount paths so the caller just
/// `.merge()`s. This router carries **no** loopback-peer gate of its own —
/// the host applies that defense-in-depth to the whole merged surface via
/// [`layer_router_with_loopback_peer_gating`]. Mounting `router()` directly
/// without that wrapper leaves `/oauth/*` and `/access/*` reachable from
/// non-loopback peers.
pub fn router(state: AppState) -> Router {
    let (documented, _spec) = documented_router().split_for_parts();
    let access = Router::new()
        .merge(handlers::grants::router())
        .merge(handlers::oauth_consents::router())
        .merge(handlers::devices::router())
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::require_owner_auth,
        ));

    Router::new()
        .merge(documented)
        .nest("/access", access)
        .with_state(state)
}

/// Wrap a router (e.g. emr-rust's FHIR router) with JWT verification against the
/// gatekeeper's signing keys. Any request missing or presenting an invalid
/// bearer token gets 401 — **except** requests whose path is listed in
/// `exempt_paths`, which pass through untouched. The exemption exists for the
/// FHIR/SMART discovery docs (`/fhir-r4/metadata`, `…/.well-known/smart-configuration`,
/// etc.) a client must fetch *before* it holds a token. Matching is exact on the
/// full request path with a trailing slash ignored (see `is_exempt`). Pass `&[]`
/// to gate every path.
pub fn layer_router_with_gatekeeper_auth_gating(
    router: Router,
    state: AppState,
    exempt_paths: &[&str],
) -> Router {
    let gate = middleware::BearerGate {
        state,
        exempt: exempt_paths
            .iter()
            .map(|p| p.trim_end_matches('/').to_string())
            .collect(),
    };
    router.layer(axum_middleware::from_fn_with_state(
        gate,
        middleware::require_valid_bearer_token,
    ))
}

/// Wrap a router with the loopback-peer gate ([`require_loopback_peer`]) — the
/// same peer-address check the gatekeeper applies to its own surface
/// ([`router`]). A request whose peer
/// socket is not a loopback address — and, failing closed, any request with no
/// `ConnectInfo` (i.e. the service wasn't mounted with
/// `into_make_service_with_connect_info`) — gets a `403` before any handler
/// runs.
///
/// Use to extend that defense-in-depth to other loopback-only routers — e.g.
/// the host's merged `api_router`, every endpoint of which is meant to be
/// reached only over the loopback socket (directly, or via the trusted front,
/// which proxies relayed remote traffic from loopback too). A forwarded remote
/// caller still passes — its peer is the loopback front — and is told apart
/// downstream by the `Forwarded` header; only a genuinely non-loopback peer is
/// rejected. (Stacking this on a router that already carries the gate — the
/// gatekeeper's own — is a harmless, idempotent second check.)
pub fn layer_router_with_loopback_peer_gating(router: Router) -> Router {
    router.layer(axum_middleware::from_fn(middleware::require_loopback_peer))
}

#[cfg(test)]
mod openapi_tests {
    use utoipa::openapi::Info;

    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/gatekeeper-oauth.openapi.json"
    );

    /// The gatekeeper OAuth + discovery `OpenAPI` document. `info` is set
    /// explicitly so the committed snapshot doesn't churn with the crate
    /// version. Test-only — nothing serves the spec at runtime.
    fn openapi_spec() -> utoipa::openapi::OpenApi {
        let (_router, mut spec) = super::documented_router().split_for_parts();
        spec.info = Info::new("Gatekeeper OAuth API", "0.0.0");
        spec
    }

    /// The generated `OpenAPI` document must match the committed snapshot. A wire
    /// type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(&openapi_spec(), SPEC_PATH);
    }
}
