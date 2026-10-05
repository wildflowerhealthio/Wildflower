//! The admin API, served only on `admin.<domain>` and only to requests
//! signed with `keyid="admin"`.
//!
//! - `POST /api/tunnels` `{"email": "…", "name": "…"}` (`name` optional):
//!   `201 {"name", "token", "public_host"}`. The token is shown only here.
//! - `GET /api/tunnels`: `200 [{"name", "email", "public_host",
//!   "created_at"}]`. No tokens.
//! - `DELETE /api/tunnels/{name}`: `204` once the tunnel is gone.
//!
//! On any other `Host` these paths are `404`, before the signature is
//! looked at, so `@target-uri` always names the admin hostname. A request
//! that fails verification, or is signed by a tunnel, is a bare `401`: each
//! handler acquires its capability through the [`Admin`] extractor, which
//! builds it only for the admin signer, before the body is read. Refused
//! changes answer with a short plain-text reason: `422` for a name that is
//! not a lowercase DNS label or an unusable email, `409` for a name that is
//! reserved or taken, `404` for deleting a tunnel that does not exist, and
//! `503` when no name is left.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::Json;
use serde::{Deserialize, Serialize, Serializer};

use super::signature::{authority, require_signature, Verifier};
use crate::domain::{StoredTunnel, TunnelError};
use crate::live_bindings::state::TunnelRegistry;
use crate::live_bindings::{Admin, LiveTunnelsCreator, LiveTunnelsDeleter, LiveTunnelsReader};
use crate::settings::Secret;

/// The routes above, changing tunnels through capabilities built from
/// `registry` and checking signatures with `verifier`.
pub(super) fn router(registry: Arc<TunnelRegistry>, verifier: Arc<Verifier>) -> axum::Router {
    let admin_hostname: Arc<str> = registry.admin_hostname().into();
    axum::Router::new()
        .route("/api/tunnels", get(list).post(create))
        .route("/api/tunnels/{name}", delete(remove))
        .route_layer(middleware::from_fn_with_state(verifier, require_signature))
        // The outer layer: the host is checked before the signature.
        .route_layer(middleware::from_fn_with_state(
            admin_hostname,
            require_admin_host,
        ))
        .with_state(registry)
}

/// `404` unless the request's authority is the admin hostname.
async fn require_admin_host(
    State(admin_hostname): State<Arc<str>>,
    request: Request,
    next: Next,
) -> Response {
    let (parts, body) = request.into_parts();
    if authority(&parts).as_deref() != Some(&*admin_hostname) {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(Request::from_parts(parts, body)).await
}

/// The body of `POST /api/tunnels`.
#[derive(Debug, Deserialize)]
struct CreateTunnel {
    email: String,
    name: Option<String>,
}

/// A tunnel as `GET /api/tunnels` lists it: no token.
#[derive(Debug, Serialize)]
struct TunnelInfo {
    name: String,
    email: String,
    /// `<tunnel name>.<domain>`.
    public_host: String,
    /// Unix epoch seconds.
    created_at: i64,
}

impl TunnelInfo {
    fn new(stored: StoredTunnel, public_host: String) -> Self {
        Self {
            name: stored.tunnel.name,
            email: stored.email,
            public_host,
            created_at: stored.created_at,
        }
    }
}

/// A tunnel just created, as `POST /api/tunnels` answers. The only place its
/// token is ever shown.
#[derive(Debug, Serialize)]
struct CreatedTunnel {
    name: String,
    #[serde(serialize_with = "expose")]
    token: Secret,
    /// `<tunnel name>.<domain>`.
    public_host: String,
}

impl CreatedTunnel {
    fn new(stored: StoredTunnel, public_host: String) -> Self {
        Self {
            name: stored.tunnel.name,
            token: stored.tunnel.token,
            public_host,
        }
    }
}

fn expose<S: Serializer>(secret: &Secret, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(secret.expose())
}

/// The body is checked only after the signer: [`Admin`] runs first, so a
/// tunnel-signed request is `401` whatever it carries.
async fn create(
    Admin(creator): Admin<LiveTunnelsCreator>,
    body: Result<Json<CreateTunnel>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    match creator.create(body.email, body.name).await {
        Ok(stored) => {
            let public_host = creator.public_host(&stored.tunnel.name);
            let created = CreatedTunnel::new(stored, public_host);
            (StatusCode::CREATED, Json(created)).into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn list(Admin(reader): Admin<LiveTunnelsReader>) -> Response {
    match reader.list().await {
        Ok(stored) => {
            let listed: Vec<_> = stored
                .into_iter()
                .map(|stored| {
                    let public_host = reader.public_host(&stored.tunnel.name);
                    TunnelInfo::new(stored, public_host)
                })
                .collect();
            Json(listed).into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn remove(Admin(deleter): Admin<LiveTunnelsDeleter>, Path(name): Path<String>) -> Response {
    match deleter.delete(name).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.into_response(),
    }
}

impl IntoResponse for TunnelError {
    fn into_response(self) -> Response {
        let (status, reason) = match self {
            Self::InvalidName => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "the name is not a lowercase DNS label",
            ),
            Self::InvalidEmail => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "the email is not an email address",
            ),
            Self::Reserved => (StatusCode::CONFLICT, "the name is reserved"),
            Self::Taken => (StatusCode::CONFLICT, "a tunnel already has the name"),
            Self::NotFound => (StatusCode::NOT_FOUND, "no tunnel has the name"),
            Self::Exhausted(reason) => (StatusCode::SERVICE_UNAVAILABLE, reason),
            Self::Infrastructure { context, source } => {
                tracing::error!("tunnel change failed: {context}: {source}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        (status, reason).into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{header, Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::live_bindings::LiveTunnelsCreator;
    use crate::site::signature::tests::signed_request;
    use crate::site::signature::unix_now;
    use crate::test_support::{admin, registry, Fixture};

    const ADMIN_KEY: &str = "an-admin-key-of-thirty-two-bytes";
    const ADMIN: &str = "https://admin.relay.example.com";

    /// A request to `uri` signed with the admin key, a fresh nonce each time.
    fn admin_request(method: &str, uri: &str, body: &serde_json::Value) -> Request<Body> {
        let body = if body.is_null() {
            Vec::new()
        } else {
            serde_json::to_vec(body).unwrap()
        };
        let nonce = format!("{:x}", rand::random::<u64>());
        let mut request = signed_request(
            method,
            uri,
            &body,
            "admin",
            ADMIN_KEY,
            unix_now().unwrap(),
            &nonce,
        );
        if !body.is_empty() {
            request
                .headers_mut()
                .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        }
        request
    }

    async fn send(router: &axum::Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, body.to_vec())
    }

    fn json(body: &[u8]) -> serde_json::Value {
        serde_json::from_slice(body).unwrap()
    }

    /// The admin router over a fresh registry holding the tunnel `alice`,
    /// whose token is returned.
    async fn router_with_alice() -> (axum::Router, Arc<TunnelRegistry>, String, Fixture) {
        let (registry, fixture) = registry(Some(ADMIN_KEY)).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let alice = creator
            .create("alice@example.com".to_owned(), Some("alice".to_owned()))
            .await
            .unwrap();
        let router = router(Arc::clone(&registry), registry.verifier());
        let token = alice.tunnel.token.expose().to_owned();
        (router, registry, token, fixture)
    }

    #[tokio::test]
    async fn creates_lists_and_deletes_tunnels() {
        let (router, tunnels, _, _fixture) = router_with_alice().await;

        let (status, body) = send(
            &router,
            admin_request(
                "POST",
                &format!("{ADMIN}/api/tunnels"),
                &serde_json::json!({"email": "bob@example.com", "name": "bob"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let created = json(&body);
        assert_eq!(created["name"], "bob");
        assert_eq!(created["public_host"], "bob.relay.example.com");
        assert_eq!(created["token"].as_str().unwrap().len(), 43);

        let (status, body) = send(
            &router,
            admin_request(
                "POST",
                &format!("{ADMIN}/api/tunnels"),
                &serde_json::json!({"email": "carol@example.com"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let generated = json(&body)["name"].as_str().unwrap().to_owned();
        assert_eq!(generated.split('-').count(), 2, "{generated}");

        let (status, body) = send(
            &router,
            admin_request(
                "GET",
                &format!("{ADMIN}/api/tunnels"),
                &serde_json::Value::Null,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let listed = json(&body);
        let listed = listed.as_array().unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0]["name"], "alice");
        let bob = listed.iter().find(|t| t["name"] == "bob").unwrap();
        let created_at = bob["created_at"].as_i64().unwrap();
        assert_eq!(
            *bob,
            serde_json::json!({
                "name": "bob",
                "email": "bob@example.com",
                "public_host": "bob.relay.example.com",
                "created_at": created_at,
            })
        );
        assert!(listed.iter().all(|t| t.get("token").is_none()));

        let (status, _) = send(
            &router,
            admin_request(
                "DELETE",
                &format!("{ADMIN}/api/tunnels/bob"),
                &serde_json::Value::Null,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(tunnels.list().await.len(), 2);
    }

    #[tokio::test]
    async fn refuses_bad_names_reserved_names_conflicts_and_unknown_deletes() {
        let (router, tunnels, _, _fixture) = router_with_alice().await;
        let post =
            |body: serde_json::Value| admin_request("POST", &format!("{ADMIN}/api/tunnels"), &body);
        for (body, expected) in [
            (
                serde_json::json!({"email": "x@example.com", "name": "Not_A_Label"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                serde_json::json!({"email": "not an email", "name": "bob"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                serde_json::json!({"name": "bob"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                serde_json::json!({"email": "x@example.com", "name": "admin"}),
                StatusCode::CONFLICT,
            ),
            (
                serde_json::json!({"email": "x@example.com", "name": "alice"}),
                StatusCode::CONFLICT,
            ),
        ] {
            let (status, _) = send(&router, post(body.clone())).await;
            assert_eq!(status, expected, "{body}");
        }
        let uri = format!("{ADMIN}/api/tunnels/nobody");
        let (status, _) = send(
            &router,
            admin_request("DELETE", &uri, &serde_json::Value::Null),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(tunnels.list().await.len(), 1);
    }

    #[tokio::test]
    async fn refuses_unsigned_wrongly_signed_and_tunnel_signed_requests() {
        let (router, tunnels, alice, _fixture) = router_with_alice().await;
        let uri = format!("{ADMIN}/api/tunnels");
        let now = unix_now().unwrap();
        let unsigned = Request::builder()
            .uri("/api/tunnels")
            .header(header::HOST, "admin.relay.example.com")
            .body(Body::empty())
            .unwrap();
        for request in [
            unsigned,
            signed_request("GET", &uri, b"", "admin", "not-the-admin-key", now, "a"),
            signed_request("GET", &uri, b"", "alice", &alice, now, "b"),
            signed_request("POST", &uri, b"not json", "alice", &alice, now, "d"),
            signed_request(
                "DELETE",
                &format!("{uri}/alice"),
                b"",
                "alice",
                &alice,
                now,
                "c",
            ),
        ] {
            let (status, body) = send(&router, request).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(body.is_empty(), "a 401 carries no detail");
        }
        assert_eq!(tunnels.list().await.len(), 1, "alice is still there");
    }

    /// On the apex (or any other host) the admin paths do not exist, even
    /// for a request properly signed for that host.
    #[tokio::test]
    async fn the_admin_api_is_only_on_the_admin_hostname() {
        let (tunnels, _fixture) = registry(Some(ADMIN_KEY)).await;
        let router = router(Arc::clone(&tunnels), tunnels.verifier());
        for host in ["https://relay.example.com", "https://other.example.com"] {
            let request = admin_request(
                "GET",
                &format!("{host}/api/tunnels"),
                &serde_json::Value::Null,
            );
            let (status, _) = send(&router, request).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{host}");
        }
        // The host is checked before the signature: an unsigned request, or
        // one with a method the API lacks, is `404` too, not `401` or `405`.
        for method in ["GET", "PUT"] {
            let request = Request::builder()
                .method(method)
                .uri("/api/tunnels")
                .header(header::HOST, "relay.example.com")
                .body(Body::empty())
                .unwrap();
            let (status, _) = send(&router, request).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method}");
        }
    }
}
