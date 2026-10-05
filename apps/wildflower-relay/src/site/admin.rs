//! The admin API, served only on `admin.<domain>` and only to requests
//! signed with `keyid="admin"`.
//!
//! - `POST /api/tunnels` `{"email": "…", "name": "…"}` (`name` optional):
//!   `201 {"name", "token", "public_host"}`. The token is shown only here.
//! - `GET /api/tunnels`: `200 [{"name", "email", "public_host",
//!   "created_at", "source"}]`, `source` being `"env"` or `"store"`. No
//!   tokens.
//! - `DELETE /api/tunnels/{name}`: `204` once the stored tunnel is gone.
//!
//! On any other `Host` these paths are `404`, before the signature is
//! looked at, so `@target-uri` always names the admin hostname. A request
//! that fails verification, or is signed by a tunnel, is a bare `401`.
//! Refused changes answer with a short plain-text reason: `422` for a name
//! that is not a lowercase DNS label or an unusable email, `409` for a name
//! that is reserved or taken and for deleting a tunnel from the
//! environment, `404` for deleting one that does not exist, and `503` when
//! no name or port is left.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::Json;
use serde::Deserialize;

use super::signature::{authority, require_signature, SignedBy, Verifier};
use crate::tunnels::{TunnelError, TunnelRegistry};

/// The routes above, changing tunnels through `tunnels` and checking
/// signatures with `verifier`.
pub(super) fn router(tunnels: Arc<TunnelRegistry>, verifier: Arc<Verifier>) -> axum::Router {
    axum::Router::new()
        .route("/api/tunnels", get(list).post(create))
        .route("/api/tunnels/{name}", delete(remove))
        .route_layer(middleware::from_fn_with_state(verifier, require_signature))
        // The outer layer: the host is checked before the signature.
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&tunnels),
            require_admin_host,
        ))
        .with_state(tunnels)
}

/// `404` unless the request's authority is the admin hostname.
async fn require_admin_host(
    State(tunnels): State<Arc<TunnelRegistry>>,
    request: Request,
    next: Next,
) -> Response {
    let (parts, body) = request.into_parts();
    if authority(&parts) != Some(tunnels.admin_hostname()) {
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

/// The body is checked only after the signer, so a tunnel-signed request is
/// `401` whatever it carries.
async fn create(
    State(tunnels): State<Arc<TunnelRegistry>>,
    signed_by: SignedBy,
    body: Result<Json<CreateTunnel>, JsonRejection>,
) -> Response {
    if signed_by != SignedBy::Admin {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    match tunnels.create(&body.email, body.name.as_deref()).await {
        Ok(created) => (StatusCode::CREATED, Json(created)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn list(State(tunnels): State<Arc<TunnelRegistry>>, signed_by: SignedBy) -> Response {
    if signed_by != SignedBy::Admin {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(tunnels.list().await).into_response()
}

async fn remove(
    State(tunnels): State<Arc<TunnelRegistry>>,
    signed_by: SignedBy,
    Path(name): Path<String>,
) -> Response {
    if signed_by != SignedBy::Admin {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match tunnels.delete(&name).await {
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
            Self::FromEnvironment => (
                StatusCode::CONFLICT,
                "the tunnel is in WILDFLOWER_RELAY_TUNNELS; remove it there",
            ),
            Self::Exhausted(reason) => (StatusCode::SERVICE_UNAVAILABLE, reason),
            Self::Internal(error) => {
                tracing::error!("tunnel change failed: {error:#}");
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
    use crate::site::signature::tests::signed_request;
    use crate::site::signature::unix_now;
    use crate::tunnels::tests::registry;

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

    #[tokio::test]
    async fn creates_lists_and_deletes_tunnels() {
        let (tunnels, _dir) = registry("alice=alice-token", Some(ADMIN_KEY)).await;
        let tunnels = Arc::new(tunnels);
        let router = router(Arc::clone(&tunnels), tunnels.verifier());

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
        assert_eq!(
            listed[0],
            serde_json::json!({
                "name": "alice",
                "email": null,
                "public_host": "alice.relay.example.com",
                "created_at": null,
                "source": "env",
            })
        );
        let bob = listed.iter().find(|t| t["name"] == "bob").unwrap();
        assert_eq!(bob["email"], "bob@example.com");
        assert_eq!(bob["source"], "store");
        assert!(bob["created_at"].is_i64());
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
    async fn refuses_bad_names_reserved_names_conflicts_and_env_deletes() {
        let (tunnels, _dir) = registry("alice=alice-token", Some(ADMIN_KEY)).await;
        let tunnels = Arc::new(tunnels);
        let router = router(Arc::clone(&tunnels), tunnels.verifier());
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
        for (name, expected) in [
            ("alice", StatusCode::CONFLICT),
            ("nobody", StatusCode::NOT_FOUND),
        ] {
            let uri = format!("{ADMIN}/api/tunnels/{name}");
            let (status, _) = send(
                &router,
                admin_request("DELETE", &uri, &serde_json::Value::Null),
            )
            .await;
            assert_eq!(status, expected, "{name}");
        }
        assert_eq!(tunnels.list().await.len(), 1);
    }

    #[tokio::test]
    async fn refuses_unsigned_wrongly_signed_and_tunnel_signed_requests() {
        let (tunnels, _dir) = registry("alice=alice-token", Some(ADMIN_KEY)).await;
        let tunnels = Arc::new(tunnels);
        let router = router(Arc::clone(&tunnels), tunnels.verifier());
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
            signed_request("GET", &uri, b"", "alice", "alice-token", now, "b"),
            signed_request("POST", &uri, b"not json", "alice", "alice-token", now, "d"),
            signed_request(
                "DELETE",
                &format!("{uri}/alice"),
                b"",
                "alice",
                "alice-token",
                now,
                "c",
            ),
        ] {
            let (status, body) = send(&router, request).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(body.is_empty(), "a 401 carries no detail");
        }
    }

    /// On the apex (or any other host) the admin paths do not exist, even
    /// for a request properly signed for that host.
    #[tokio::test]
    async fn the_admin_api_is_only_on_the_admin_hostname() {
        let (tunnels, _dir) = registry("", Some(ADMIN_KEY)).await;
        let tunnels = Arc::new(tunnels);
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
    }
}
