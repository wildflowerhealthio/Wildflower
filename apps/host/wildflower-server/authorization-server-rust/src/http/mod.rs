//! The authorization server's HTTP layer — everything axum-shaped lives under this
//! module. The only crate-facing surface is [`router`], the layerable bearer gate
//! ([`authorization_server_auth_middleware`]), and
//! [`AuthorizationServerState`]; the handler and middleware files are private
//! implementation detail behind the route table.

use std::sync::Arc;

mod browser_session_cookie;
mod errors;
mod extractors;
mod middleware;
mod routes;
mod state;
mod wire_representations;

pub(crate) use routes::oauth::device_page_url;
// The shared "insert an `Authorization: Bearer` only when absent" helper — the
// host's FHIR web UI session middleware uses it.
pub use middleware::ensure_bearer_header;
// The layerable bearer gate the host composes its router from, in `middleware/`.
pub(crate) use browser_session_cookie::browser_session_set_cookie;
pub use browser_session_cookie::{
    browser_session_clearing_set_cookie, record_browser_session_cookie_use,
    standing_browser_session, BROWSER_SESSION_COOKIE, BROWSER_SESSION_HEADER_VALUE, SESSION_HEADER,
};
pub use middleware::{authorization_server_auth_middleware, AuthorizationServerAuthMiddleware};
pub use state::AuthorizationServerState;

use axum::middleware as axum_middleware;
use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::{OpenApiRouter, UtoipaMethodRouter, UtoipaMethodRouterExt as _};
use utoipa_axum::routes;

use crate::domain::capabilities::oauth::ClientScopesReader;

/// Base `OpenAPI` document; the collected routes fill in paths + components.
/// The shared `InsufficientScopeBody` is registered here so the
/// [`InsufficientScopeResponses`](wildflowerhealthio_scope_capabilities::InsufficientScopeResponses)
/// addon in `openapi_spec` can `$ref` it on the scope-gated `/authorization` paths.
#[derive(OpenApi)]
#[openapi(components(schemas(wildflowerhealthio_scope_capabilities::InsufficientScopeBody)))]
struct ApiDoc;

/// The documented **pre-auth** surface — jwks + the OAuth group — as an
/// `OpenApiRouter`, so the spec is collected from the very routes that serve
/// traffic. `limit_authorization_starts` wraps the routes that start an
/// authorization request (see [`routes::oauth::openapi_router`]).
fn documented_public_router(
    limit_authorization_starts: impl Fn(
        UtoipaMethodRouter<Arc<AuthorizationServerState>>,
    ) -> UtoipaMethodRouter<Arc<AuthorizationServerState>>,
) -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(routes::well_known_jwks::handle_jwks_request))
        .nest(
            routes::oauth::OAUTH_MOUNT,
            routes::oauth::openapi_router(limit_authorization_starts),
        )
}

/// The spec-only view of the whole documented surface: the pre-auth routes
/// plus the documented slice of `/authorization` (the `/clients` routes; the rest of
/// the admin surface is not documented yet). Never served as-is — [`router`]
/// mounts the `/authorization` half behind the session gate.
#[cfg(test)]
fn documented_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    documented_public_router(std::convert::identity)
        .nest("/authorization", routes::clients::openapi_router())
}

/// Build the authorization server's public HTTP surface. Routes live at
/// `/.well-known/jwks.json`, `/oauth/*`, and `/authorization/*` (authenticated
/// bearer JWT + per-resource scope gates) — the module owns its mount paths so the caller just
/// `.merge()`s. The host's tunnel listener serves it to remote visitors,
/// behind these bearer and session gates.
pub fn router(state: Arc<AuthorizationServerState>) -> Router {
    let (documented, _spec) = documented_public_router(|routes| {
        routes.layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::limit_authorization_starts,
        ))
    })
    .split_for_parts();
    let (clients, _spec) = routes::clients::openapi_router().split_for_parts();
    let access = Router::new()
        .merge(clients)
        .merge(routes::grants::router())
        .merge(routes::oauth_consents::router())
        .merge(routes::devices::router())
        .merge(routes::logout::router())
        .merge(routes::revocations::router())
        .merge(routes::session::router())
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::require_valid_session,
        ))
        // Outermost, so the session gate's 401s are cache-suppressed too.
        .layer(axum_middleware::from_fn(middleware::cache_suppress));

    Router::new()
        .merge(documented)
        .nest(routes::oauth::OAUTH_MOUNT, routes::oauth::page_router())
        .nest("/authorization", access)
        .with_state(state)
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
    state: &AuthorizationServerState,
    client_id: &str,
) -> anyhow::Result<Vec<wildflowerhealthio_scopes::Scope>> {
    let reader = ClientScopesReader::new(state.store.clone());
    Ok(reader.registered_client_scopes(client_id)?)
}

/// The authorization server OAuth + discovery + client-management `OpenAPI` document, collected from the very
/// routes that serve traffic. `info` is set explicitly so the committed snapshot
/// doesn't churn with the crate version. It generates the committed snapshot the
/// TS spec-drift test guards and the published server-docs console renders.
#[cfg(test)]
fn openapi_spec() -> utoipa::openapi::OpenApi {
    use utoipa::Modify as _;

    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("Wildflower Authorization OAuth API", "0.0.0");
    // Every documented `/authorization` operation is scope-gated (the ungated
    // `/authorization/session` isn't documented), so the gated paths are read off the
    // spec rather than listed by hand.
    let gated_paths: Vec<String> = spec
        .paths
        .paths
        .keys()
        .filter(|path| path.starts_with("/authorization/"))
        .cloned()
        .collect();
    wildflowerhealthio_scope_capabilities::InsufficientScopeResponses::for_paths(gated_paths)
        .modify(&mut spec);
    spec
}

#[cfg(test)]
mod openapi_tests {
    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/authorization-server-oauth.openapi.json"
    );

    /// The generated `OpenAPI` document must match the committed snapshot. A wire
    /// type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p wildflowerhealthio-authorization-server openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        wildflowerhealthio_shared_structures::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
