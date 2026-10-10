//! The apps slice's HTTP surface — list, launch, home-screen, and the admin
//! write surface — built as `utoipa_axum::OpenApiRouter`s, so the same
//! `#[utoipa::path]`-annotated handlers that serve traffic also produce the
//! committed OpenAPI snapshot (`openapi/apps.openapi.json`) that the TS spec-drift
//! test reads.
//!
//! Module layout:
//!
//!  - [`routes`] — one file per route named by operation, under a folder tree
//!    mirroring the URL tree (`routes/apps/*` for the `/apps` segment,
//!    `routes/home_screen.rs` for the flat `/home-screen` route). The route
//!    table lives in [`routes`]; the route files stay pure.
//!  - [`errors`] — the wire bodies + `impl IntoResponse` for
//!    [`AppsError`](crate::domain::AppsError).
//!  - [`ports`](crate::ports) — the host-seam dependency-inversion traits
//!    ([`AppLaunchScopes`](crate::ports::AppLaunchScopes),
//!    [`LaunchContextMinter`](crate::ports::LaunchContextMinter)) the host wires
//!    into [`AppsState`].
//!
//! The shared [`AppsState`] itself lives at the crate root
//! ([`crate::live_bindings::state`]) so the scope-gated capability bindings sit
//! beside it (see that module).
//!
//! The surface is exposed as one [`router`] carrying no middleware; the host wraps
//! it with its bearer gate (which inserts the caller's scope claims). Each handler
//! is scope-gated: the catalogue reads and writes and `PUT /home-screen` on
//! `wildflower/Apps.*`, the launch on the `wildflower/launch` umbrella (plus a
//! per-app SMART check in the handler).

mod errors;
mod routes;
#[cfg(test)]
pub(crate) mod test_support;

// The router builders below name the shared state. Its canonical public path is
// `apps_rust::live_bindings::state::AppsState` (also re-exported crate-root as
// `apps_rust::AppsState`); this is a private import, not another public path.
use crate::live_bindings::state::AppsState;

use std::sync::Arc;

use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;

/// Base `OpenAPI` document; the collected routes fill in paths + components.
#[derive(OpenApi)]
struct ApiDoc;

/// The apps surface as an `OpenApiRouter`, so the spec is collected from the
/// same routes that serve traffic.
fn documented_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(routes::openapi_router())
}

/// The apps `OpenAPI` document — every endpoint the TS `AppsApi` /
/// `AppsAdminApi` clients speak. `info` is set explicitly so the committed
/// snapshot doesn't churn with the crate version.
#[cfg(test)]
fn openapi_spec() -> utoipa::openapi::OpenApi {
    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("Apps Catalogue API", "0.0.0");
    spec
}

/// Build every apps route: the admin routes (`GET`/`POST /apps`,
/// `GET`/`PUT`/`DELETE /apps/{id}`, and `PUT /home-screen`), each gated on
/// `wildflower/Apps.{r,c,u,d}`, and the launch route (`POST /apps/{id}`), gated on
/// the `wildflower/launch` umbrella by the
/// [`Scoped<LiveAppLauncher>`](crate::live_bindings::LiveAppLauncher) extractor
/// before the handler runs, with a SMART app additionally requiring the caller's
/// grant to cover its OAuth client's scopes. Carries no middleware — the host
/// wraps it with its bearer gate (which inserts the caller's scope claims).
pub fn router(state: Arc<AppsState>) -> Router {
    let (router, _spec) = documented_router().split_for_parts();
    router.with_state(state)
}

#[cfg(test)]
mod openapi_tests {
    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/openapi/apps.openapi.json");

    /// The generated `OpenAPI` document must match the committed snapshot. A
    /// wire-type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p apps-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
