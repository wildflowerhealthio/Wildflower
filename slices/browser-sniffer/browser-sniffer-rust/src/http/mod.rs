//! The browser-sniffer slice's HTTP surface — the `/sniffer` control endpoints
//! built as a `utoipa_axum::OpenApiRouter` (so the same `#[utoipa::path]`
//! handlers that serve traffic also produce the committed OpenAPI snapshot,
//! `openapi/browser-sniffer.openapi.json`, that the TS spec-drift test reads)
//! plus the `/sniffer/events` WebSocket, which lives outside the OpenAPI
//! document (no WS operation shape) and is contract-pinned by the TS message
//! schemas and the Rust tag drift-guards instead.
//!
//! The router carries no middleware, but every endpoint is scope-gated per
//! operation — its handler reaches the host only through a `Scoped<…>`
//! capability (see [`crate::domain::capabilities`]), gated by
//! `wildflower/Sniffer.<perm>`. The host still wraps the built router with its
//! bearer gate (`gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`),
//! which inserts the `ScopeClaims` those capabilities read, mirroring the
//! collector and tunnel surfaces.

mod errors;
mod routes;

use std::sync::Arc;

use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;

use crate::live_bindings::state::SnifferState;

/// Base `OpenAPI` document; the collected routes fill in paths + components.
#[derive(OpenApi)]
struct ApiDoc;

/// The REST half as an `OpenApiRouter`, so the spec is collected from the same
/// routes that serve traffic (mirrors `collector-rust` / `tunnel-rust`).
fn documented_router() -> OpenApiRouter<Arc<SnifferState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(routes::openapi_router())
}

/// Build the `/sniffer` routes (REST + the events WebSocket). Carries no
/// middleware — the host wraps it with its bearer gate.
pub fn router(state: Arc<SnifferState>) -> Router {
    let (rest, _spec) = documented_router().split_for_parts();
    rest.merge(routes::events_router()).with_state(state)
}

/// The sniffer `OpenAPI` document — every REST endpoint the TS
/// `BrowserSnifferApi` client speaks — collected from the same routes that
/// serve traffic. `info` is set explicitly so the committed snapshot doesn't
/// churn with the crate version. The `/sniffer/events` WebSocket is
/// deliberately absent (see the module docs).
#[must_use]
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("Browser Sniffer API", "0.0.0");
    spec
}

#[cfg(test)]
mod openapi_tests {
    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/browser-sniffer.openapi.json"
    );

    /// The generated `OpenAPI` document must match the committed snapshot. A
    /// wire-type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p browser-sniffer-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
