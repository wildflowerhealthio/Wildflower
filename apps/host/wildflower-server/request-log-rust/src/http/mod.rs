//! The request log's HTTP surface — `GET /requests` and `GET /requests/callers`
//! — built as a `utoipa_axum::OpenApiRouter`, so the same
//! `#[utoipa::path]`-annotated handlers that serve traffic also produce the
//! committed OpenAPI snapshot (`openapi/request-log.openapi.json`) that the TS
//! spec-drift test
//! (`request-log-core-js/src/http-api-definition/openapi-drift.test.ts`) reads.
//!
//! The router carries no middleware, but every endpoint is scope-gated — its
//! handler reaches the store only through a `Scoped<…>` capability (see
//! [`crate::domain::capabilities`]), gated by `wildflower/RequestLog.r` and
//! answering a `403 InsufficientScope` when the caller's token doesn't cover
//! it. The server still layers the built router with its bearer gate
//! (`wildflowerhealthio_gatekeeper::gatekeeper_auth_middleware`), which inserts the
//! `ScopeClaims` the capability reads.

mod errors;
mod routes;

use std::sync::Arc;

use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;

use crate::live_bindings::state::RequestLogState;

/// Base `OpenAPI` document; the collected routes fill in paths + components.
#[derive(OpenApi)]
struct ApiDoc;

/// The `/requests` surface as an `OpenApiRouter`, so the spec is collected from
/// the same routes that serve traffic (mirrors `collector-rust`).
fn documented_router() -> OpenApiRouter<Arc<RequestLogState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(routes::openapi_router())
}

/// Build the `/requests` routes over a [`RequestLogState`]. Carries no
/// middleware — the server wraps it with its bearer gate.
pub fn router(state: Arc<RequestLogState>) -> Router {
    let (router, _spec) = documented_router().split_for_parts();
    router.with_state(state)
}

/// The request-log `OpenAPI` document, collected from the same routes that
/// serve traffic. `info` is set explicitly so the committed snapshot doesn't
/// churn with the crate version. It generates the committed snapshot the TS
/// spec-drift test guards and the published server-docs console renders.
#[cfg(test)]
fn openapi_spec() -> utoipa::openapi::OpenApi {
    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("Request Log API", "0.0.0");
    spec
}

#[cfg(test)]
mod openapi_tests {
    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/request-log.openapi.json"
    );

    /// The generated `OpenAPI` document must match the committed snapshot. A wire
    /// type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p wildflowerhealthio-request-log openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        wildflowerhealthio_shared_structures::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
