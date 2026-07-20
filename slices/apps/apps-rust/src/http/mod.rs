//! The apps slice's HTTP surface — list, launch, home-screen, and the cloud-admin
//! write surface — built as `utoipa_axum::OpenApiRouter`s, so the same
//! `#[utoipa::path]`-annotated handlers that serve traffic also produce the
//! committed OpenAPI snapshot (`openapi/apps.openapi.json`) that the TS spec-drift
//! test reads.
//!
//! Module layout:
//!
//!  - [`routes`] — one file per route named by operation, under a folder tree
//!    mirroring the URL tree (`routes/apps/*` for the `/apps` segment,
//!    `routes/home_screen.rs` for the flat `/home-screen` route). The
//!    gated/launch router split lives in [`routes`]; the route files stay pure.
//!  - [`errors`] — the wire bodies + `impl IntoResponse` for
//!    [`AppsError`](crate::domain::AppsError).
//!  - [`ports`](crate::ports) — the host-seam dependency-inversion traits
//!    ([`AppLaunchScopes`](crate::ports::AppLaunchScopes),
//!    [`LaunchCookies`](crate::ports::LaunchCookies)) the host wires into
//!    [`AppsState`].
//!
//! The shared [`AppsState`] itself lives at the crate root
//! ([`crate::live_bindings::state`]) so the scope-gated capability bindings sit
//! beside it (see that module).
//!
//! The surface is exposed as two routers so the host can gate them differently:
//! both [`gated_router`] (list + cloud-admin + `PUT /home-screen`) and
//! [`launch_router`] (`GET` + `POST /apps/{id}`) carry no middleware and are each
//! wrapped by the host's bearer gate (which inserts the caller's scope claims). The
//! gated surface is scope-gated per handler on `wildflower/Apps.*`; the launch
//! surface on the `wildflower/launch` umbrella (plus a per-app SMART check in the
//! handler). They stay separate only so the host can size the launch body limit /
//! exempts differently.

mod errors;
mod routes;
#[cfg(test)]
pub(crate) mod test_support;
pub(crate) mod wire_representations;

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

/// The full apps surface as one `OpenAPI` document — every endpoint the TS
/// `AppsApi` client speaks (the gated list/cloud-admin/home-screen surface plus
/// the launch route, now behind the `wildflower/launch` umbrella). `info` is set
/// explicitly so the committed snapshot doesn't churn with the crate version.
#[must_use]
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    let combined = OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(routes::openapi_router());
    let (_router, mut spec) = combined.split_for_parts();
    spec.info = utoipa::openapi::Info::new("Apps Catalogue API", "0.0.0");
    spec
}

/// Build the scope-gated admin routes (`GET /apps`, `DELETE /apps/{id}`,
/// `PUT /home-screen`, and the per-kind `/cloud-apps` / `/self-hosted-apps` /
/// `/system-apps` resources), each gated on `wildflower/Apps.{r,c,u,d}`. Carries
/// no middleware — the host wraps it with its bearer gate (which inserts the
/// caller's scope claims).
pub fn gated_router(state: Arc<AppsState>) -> Router {
    let (router, _spec) = routes::gated_openapi_router().split_for_parts();
    router.with_state(state)
}

/// Build the launch routes (`GET` + `POST /apps/{id}`). Carries no middleware — the
/// host wraps it with its bearer gate; the `wildflower/launch` umbrella is enforced
/// by the [`Scoped<LiveAppLauncher>`](crate::live_bindings::LiveAppLauncher)
/// extractor before the handler runs, and a SMART app additionally requires the
/// caller's grant to cover its OAuth client's scopes.
pub fn launch_router(state: Arc<AppsState>) -> Router {
    let (router, _spec) = routes::launch_openapi_router().split_for_parts();
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
