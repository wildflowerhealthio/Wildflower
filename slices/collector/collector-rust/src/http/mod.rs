//! The collector slice's HTTP surface — the five `/collector/remotes`
//! endpoints — built as a `utoipa_axum::OpenApiRouter`, so the same
//! `#[utoipa::path]`-annotated handlers that serve traffic also produce the
//! committed OpenAPI snapshot (`openapi/collector.openapi.json`) that the TS
//! spec-drift test (`collector-registry/src/http-api-definition/openapi-drift.test.ts`)
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
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;

/// Base `OpenAPI` document; the collected routes fill in paths + components.
#[derive(OpenApi)]
struct ApiDoc;

/// The `/collector/remotes` surface as an `OpenApiRouter`, so the spec is
/// collected from the same routes that serve traffic (mirrors `apps-rust` /
/// `databases-rust` / `tunnel-rust`).
fn documented_router() -> OpenApiRouter<Arc<CollectorState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(routes::openapi_router())
}

/// Build the `/collector/remotes` routes. Carries no middleware — the host
/// wraps it with its bearer gate.
pub fn router(state: Arc<CollectorState>) -> Router {
    let (router, _spec) = documented_router().split_for_parts();
    router.with_state(state)
}

/// The collector `OpenAPI` document — every endpoint the TS `CollectorApi`
/// client speaks — collected from the same routes that serve traffic. `info`
/// is set explicitly so the committed snapshot doesn't churn with the crate
/// version. Two consumers read it: the committed snapshot the TS spec-drift
/// test guards, and the host's unified `/docs` Scalar surface, which merges
/// this with the other slices' documents.
#[must_use]
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("Collector Remotes API", "0.0.0");
    spec
}

#[cfg(test)]
mod openapi_tests {
    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/collector.openapi.json"
    );

    /// The generated `OpenAPI` document must match the committed snapshot. A
    /// wire-type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p collector-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
