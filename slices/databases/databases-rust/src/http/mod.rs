//! The databases slice's HTTP surface. The only crate-facing surface is
//! [`router`] and [`DatabasesState`]; the handler files are private
//! implementation detail behind the route table.
//!
//! Built as a `utoipa_axum::OpenApiRouter`, so the same `#[utoipa::path]`
//! handlers that serve traffic also produce the committed OpenAPI snapshot
//! (`openapi/databases.openapi.json`) that the TS spec-drift test reads.

mod handlers;
mod response_templates;
mod state;
mod temp_file_stream;

pub use state::DatabasesState;

use std::sync::Arc;

use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;

/// Base `OpenAPI` document; the collected routes fill in paths + components.
#[derive(OpenApi)]
struct ApiDoc;

/// The `/databases` surface as an `OpenApiRouter`, so the spec is collected from
/// the same routes that serve traffic (mirrors `apps-rust` / `tunnel-rust`).
fn documented_router() -> OpenApiRouter<Arc<DatabasesState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(handlers::openapi_router())
}

/// Build the databases `/databases` router over a [`DatabasesState`]. The module
/// owns its mount path so the caller just `.merge()`s. Carries no middleware —
/// the host wraps it with its own auth gate.
pub fn router(state: Arc<DatabasesState>) -> Router {
    let (router, _spec) = documented_router().split_for_parts();
    router.with_state(state)
}

/// The databases `OpenAPI` document, collected from the same routes that serve
/// traffic. `info` is set explicitly so the committed snapshot doesn't churn
/// with the crate version. Two consumers read it: the committed snapshot the TS
/// spec-drift test guards, and the host's unified `/docs` Scalar surface, which
/// merges this with the other slices' documents.
#[must_use]
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("Databases API", "0.0.0");
    spec
}

#[cfg(test)]
mod openapi_tests {
    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/databases.openapi.json"
    );

    /// The generated `OpenAPI` document must match the committed snapshot. A
    /// wire-type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p databases-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
