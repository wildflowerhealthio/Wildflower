//! The gatekeeper's HTTP layer — everything axum-shaped lives under this
//! module. The only crate-facing surface is [`router`],
//! [`layer_router_with_gatekeeper_auth_gating`], and [`GatekeeperState`]; the
//! handler and middleware files are private implementation detail behind the
//! route table.

use std::sync::Arc;

pub(crate) mod capabilities;
mod errors;
mod extractors;
mod middleware;
mod routes;
mod state;
mod views;
mod wire_representations;

pub(crate) use extractors::served_origin::ServedOrigin;
pub(crate) use extractors::session::CallerSession;
// Re-export so call sites read `crate::http::served_base_url_for` without the
// `shared_structures_rust::` prefix. See `docs/Origins/Explanation.md`.
pub(crate) use shared_structures_rust::served_origin::served_base_url_for;
// The shared "insert an `Authorization: Bearer` only when absent" helper — the
// FHIR bearer gate and the Tauri loopback-owner-trust middleware both use it.
pub use middleware::ensure_bearer_header;
pub use state::GatekeeperState;

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
fn documented_router() -> OpenApiRouter<Arc<GatekeeperState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(routes::well_known_jwks::handle_jwks_request))
        .nest("/oauth", routes::oauth::openapi_router())
}

/// Build the gatekeeper's public HTTP surface. Routes live at
/// `/.well-known/jwks.json`, `/oauth/*`, and `/access/*` (authenticated
/// bearer JWT + per-resource scope gates) — the module owns its mount paths so the caller just
/// `.merge()`s. This router carries **no** loopback-peer gate of its own —
/// the host applies that defense-in-depth to the whole merged surface via
/// [`layer_router_with_loopback_peer_gating`]. Mounting `router()` directly
/// without that wrapper leaves `/oauth/*` and `/access/*` reachable from
/// non-loopback peers.
pub fn router(state: Arc<GatekeeperState>) -> Router {
    let (documented, _spec) = documented_router().split_for_parts();
    let access = Router::new()
        .merge(routes::grants::router())
        .merge(routes::oauth_consents::router())
        .merge(routes::devices::router())
        .merge(routes::logout::router())
        .merge(routes::revocations::router())
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::require_valid_session,
        ));

    Router::new()
        .merge(documented)
        .nest("/access", access)
        .with_state(state)
}

/// Wrap a router (e.g. emr-rust's FHIR router) with JWT verification against the
/// gatekeeper's signing keys. Any request missing or presenting an invalid
/// bearer token gets 401 — **except** requests whose path is in `exempt_paths`,
/// which pass through untouched: the FHIR/SMART discovery docs a client fetches
/// before it holds a token (canonical list `UNAUTHENTICATED_FHIR_PATHS` in
/// emr-rust; see `docs/Origins/Explanation.md`). Matching is exact on the full
/// request path with a trailing slash ignored (see `is_exempt`). Pass `&[]` to
/// gate every path.
pub fn layer_router_with_gatekeeper_auth_gating(
    router: Router,
    state: Arc<GatekeeperState>,
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

/// Wrap a router with the loopback-peer gate
/// ([`require_loopback_peer`](middleware::require_loopback_peer)) so a
/// non-loopback peer — and, failing closed, any request with no `ConnectInfo`
/// (the service wasn't mounted with `into_make_service_with_connect_info`) —
/// gets a `403` before any handler runs. Extends the same defense-in-depth the
/// gatekeeper applies to its own [`router`] to other loopback-only routers, e.g.
/// the host's merged `api_router`; stacking it on a router that already carries
/// the gate is a harmless, idempotent second check. For why a forwarded remote
/// caller still passes, see [`require_loopback_peer`](middleware::require_loopback_peer)
/// and `docs/Origins/Explanation.md`.
pub fn layer_router_with_loopback_peer_gating(router: Router) -> Router {
    router.layer(axum_middleware::from_fn(middleware::require_loopback_peer))
}

/// Whether `path` is on the gatekeeper's **pre-auth public surface** — the
/// discovery + OAuth routes a client reaches before it holds a token
/// (`/.well-known/*` incl. `jwks.json`, and `/oauth/*`). The `/access/*` admin
/// surface is authenticated + scope-gated and NOT public.
///
/// Owned here, beside [`router`] (which mounts these paths), so a consumer that
/// must exclude the pre-auth surface can't drift from the routes. The desktop
/// loopback-owner-trust middleware uses it to avoid stamping the owner bearer
/// onto a pre-auth request, where a stray owner bearer could confuse client
/// authentication.
#[must_use]
pub fn is_pre_auth_public_path(path: &str) -> bool {
    path.starts_with("/oauth") || path.starts_with("/.well-known")
}

/// Whether `headers` carry a valid **Owner** bearer for `served_origin` — the
/// non-middleware form of the owner check
/// ([`verify_owner_token`](middleware::require_auth::verify_owner_token)), for a
/// slice that owner-gates a single in-handler action rather than wrapping a whole
/// router. The `/access` router itself no longer owner-gates as a blanket layer:
/// it authenticates via [`require_valid_session`](middleware::require_valid_session)
/// and authorizes per-route through the scope-gated [`scoped`] extractors.
/// The apps slice wires this through `apps_rust::OwnerAuth` to gate the loopback
/// launch popup. Returns `false` for a missing, invalid, or non-owner token.
#[must_use]
pub fn verify_owner_bearer(
    state: &GatekeeperState,
    headers: &axum::http::HeaderMap,
    served_origin: &str,
) -> bool {
    let Some(token) = middleware::require_auth::try_bearer_token_from_headers(headers) else {
        return false;
    };
    middleware::require_auth::verify_owner_token(state, served_origin, token).is_ok()
}

/// The gatekeeper OAuth + discovery `OpenAPI` document, collected from the very
/// routes that serve traffic. `info` is set explicitly so the committed snapshot
/// doesn't churn with the crate version. Two consumers read it: the committed
/// snapshot the TS spec-drift test guards, and the host's unified `/docs` Scalar
/// surface, which merges this with the other slices' documents.
#[must_use]
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("Gatekeeper OAuth API", "0.0.0");
    spec
}

#[cfg(test)]
mod openapi_tests {
    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/gatekeeper-oauth.openapi.json"
    );

    /// The generated `OpenAPI` document must match the committed snapshot. A wire
    /// type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
