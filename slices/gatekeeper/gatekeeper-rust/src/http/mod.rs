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

pub(crate) use origin::{served_origin_for, ServedOrigin};
pub use state::AppState;

use axum::middleware as axum_middleware;
use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

/// Base OpenAPI document; the collected routes fill in paths + components.
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
/// `.merge()`s. The whole surface is gated by the loopback middleware —
/// non-loopback peers receive 403 before any handler runs.
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
        .layer(axum_middleware::from_fn(middleware::loopback_gate))
        .with_state(state)
}

/// Wrap a router (e.g. emr-rust's FHIR router) with JWT verification
/// against the gatekeeper's signing keys. Any request missing or
/// presenting an invalid bearer token gets 401.
pub fn layer_router_with_gatekeeper_auth_gating(router: Router, state: AppState) -> Router {
    router.layer(axum_middleware::from_fn_with_state(
        state,
        middleware::require_valid_bearer_token,
    ))
}

#[cfg(test)]
mod openapi_tests {
    use utoipa::openapi::Info;

    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/gatekeeper-oauth.openapi.json"
    );

    /// The gatekeeper OAuth + discovery OpenAPI document. `info` is set
    /// explicitly so the committed snapshot doesn't churn with the crate
    /// version. Test-only — nothing serves the spec at runtime.
    fn openapi_spec() -> utoipa::openapi::OpenApi {
        let (_router, mut spec) = super::documented_router().split_for_parts();
        spec.info = Info::new("Gatekeeper OAuth API", "0.0.0");
        spec
    }

    /// The generated OpenAPI document must match the committed snapshot. A wire
    /// type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(&openapi_spec(), SPEC_PATH);
    }
}
