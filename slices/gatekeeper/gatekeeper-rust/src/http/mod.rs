//! The gatekeeper's HTTP layer — everything axum-shaped lives under this
//! module. The only crate-facing surface is [`router`], the two layerable gates
//! ([`gatekeeper_auth_middleware`], [`require_loopback_peer_middleware`]), and
//! [`GatekeeperState`]; the handler and middleware files are private
//! implementation detail behind the route table.

use std::sync::Arc;

mod errors;
mod extractors;
mod middleware;
mod routes;
mod state;
mod wire_representations;

pub(crate) use extractors::served_origin::ServedOrigin;
// Re-export so call sites read `crate::http::served_base_url_for` without the
// `shared_structures_rust::` prefix. See `docs/Origins/Explanation.md`.
pub(crate) use shared_structures_rust::served_origin::served_base_url_for;
// The shared "insert an `Authorization: Bearer` only when absent" helper — the
// FHIR bearer gate and the Tauri loopback-owner-trust middleware both use it.
pub use middleware::ensure_bearer_header;
// The two layerable gates the host composes its routers from. Each lives beside
// the handler it wraps, in `middleware/`.
pub use middleware::{
    gatekeeper_auth_middleware, require_loopback_peer_middleware, GatekeeperAuthMiddleware,
    RequireLoopbackPeerMiddleware,
};
pub use state::GatekeeperState;

use axum::middleware as axum_middleware;
use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::domain::capabilities::oauth::ClientScopesReader;

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
/// [`require_loopback_peer_middleware`]. Mounting `router()` directly
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
        .merge(routes::session::router())
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::require_valid_session,
        ));

    Router::new()
        .merge(documented)
        .nest("/access", access)
        .with_state(state)
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

/// The scopes an OAuth client (`client_id`) is permitted to request — its stored
/// `allowed_scopes`, parsed. The apps slice's per-app SMART launch check resolves a
/// SMART app's `client_id` to this set through its `AppLaunchScopes` port (wired
/// host-side to this fn), then requires the launching caller's grant to cover it.
/// Reads through the
/// [`ClientScopesReader`](crate::domain::capabilities::oauth::ClientScopesReader)
/// so the host never touches the store. An unknown `client_id` (a
/// misconfigured registration) yields an empty set — only the launch umbrella then
/// gates the launch — and is logged as a warning so the fail-open scope downgrade
/// is detectable rather than silent.
///
/// # Errors
///
/// Propagates a store checkout / query failure.
pub fn client_allowed_scopes(
    state: &GatekeeperState,
    client_id: &str,
) -> anyhow::Result<Vec<scopes_rust::Scope>> {
    let reader = ClientScopesReader::new(state.store.clone());
    Ok(reader.allowed_scopes(client_id)?)
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
