//! The collector slice's HTTP surface — the five `/collector/remotes`
//! endpoints — built as a `utoipa_axum::OpenApiRouter`, so the same
//! `#[utoipa::path]`-annotated handlers that serve traffic also produce the
//! committed OpenAPI snapshot (`openapi/collector.openapi.json`) that the TS
//! spec-drift test (`collector-core/src/http-api-definition/openapi-drift.test.ts`)
//! reads.
//!
//! The router carries no middleware — every endpoint exposes owner-only data,
//! so the host wraps the built router with its bearer gate
//! (`gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`), mirroring
//! the tunnel and databases surfaces.

mod errors;
mod routes;
mod state;

pub use state::CollectorState;

use std::sync::Arc;

use axum::Router;

/// Build the `/collector/remotes` routes. Carries no middleware — the host
/// wraps it with its bearer gate.
pub fn router(state: Arc<CollectorState>) -> Router {
    let (router, _spec) = routes::openapi_router().split_for_parts();
    router.with_state(state)
}

#[cfg(test)]
mod openapi_tests {
    use utoipa::openapi::Info;
    use utoipa::OpenApi;
    use utoipa_axum::router::OpenApiRouter;

    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/collector.openapi.json"
    );

    /// Base `OpenAPI` document; the collected routes fill in paths + components.
    #[derive(OpenApi)]
    struct ApiDoc;

    /// The full collector surface as one document — every endpoint the TS
    /// `CollectorApi` client speaks. `info` is set explicitly so the committed
    /// snapshot doesn't churn with the crate version. Test-only — nothing
    /// serves the spec at runtime.
    fn openapi_spec() -> utoipa::openapi::OpenApi {
        let combined =
            OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(super::routes::openapi_router());
        let (_router, mut spec) = combined.split_for_parts();
        spec.info = Info::new("Collector Remotes API", "0.0.0");
        spec
    }

    /// The generated `OpenAPI` document must match the committed snapshot. A
    /// wire-type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p collector-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(&openapi_spec(), SPEC_PATH);
    }
}
