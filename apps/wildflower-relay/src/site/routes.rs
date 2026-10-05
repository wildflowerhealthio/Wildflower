//! The site's axum router: every route the relay serves on its local
//! hostnames.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Json;
use rathole_settings_rust::{PublicRatholeSettings, TunnelHost};
use shared_structures_rust::health_check::{health_router, AlwaysHealthy};

use super::signature::{require_signature, SignedBy, Verifier};

/// `GET /rathole` changes only when the relay restarts with a new
/// environment, so clients may reuse it for a minute.
const RATHOLE_CACHE_CONTROL: &str = "public, max-age=60";

/// - `GET /health`: `200 {"status":"pass"}` while the relay is up to answer.
/// - `GET /rathole`: `rathole_settings` as JSON, without authentication.
/// - `GET /me`: the signing tunnel's [`TunnelHost`], for a request signed
///   with a tunnel's token (see [`super::signature`]); `401` otherwise.
pub(super) fn router(rathole_settings: PublicRatholeSettings, verifier: Verifier) -> axum::Router {
    axum::Router::new()
        .route("/me", get(me))
        .route_layer(middleware::from_fn_with_state(
            Arc::new(verifier),
            require_signature,
        ))
        .route("/rathole", get(rathole))
        .with_state(Arc::new(rathole_settings))
        .merge(health_router(Arc::new(AlwaysHealthy)))
}

async fn rathole(State(rathole_settings): State<Arc<PublicRatholeSettings>>) -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, RATHOLE_CACHE_CONTROL)],
        Json(PublicRatholeSettings::clone(&rathole_settings)),
    )
}

async fn me(
    State(rathole_settings): State<Arc<PublicRatholeSettings>>,
    signed_by: SignedBy,
) -> Response {
    match signed_by {
        SignedBy::Tunnel(tunnel_name) => Json(TunnelHost {
            public_host: format!("{tunnel_name}.{}", rathole_settings.domain),
            tunnel_name,
        })
        .into_response(),
        SignedBy::Admin => StatusCode::UNAUTHORIZED.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::settings::{RelaySettings, Secret, Tunnel};
    use crate::site::signature::tests::signed_request;
    use crate::site::signature::unix_now;

    #[tokio::test]
    async fn rathole_serves_the_settings_from_the_environment() {
        let env = [
            ("WILDFLOWER_RELAY_DOMAIN", "relay.example.com"),
            (
                "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY",
                // From `rathole --genkey` (rathole 0.5.0).
                "HY1kqeX1WAAysgpriYop7NW/Yw7KAO//EdEBs8qxv7I=",
            ),
            ("WILDFLOWER_RELAY_CONTROL_ADDR", "0.0.0.0:7000"),
        ];
        let settings = RelaySettings::from_lookup(|name| {
            env.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        })
        .expect("settings");

        let response = router(settings.public_rathole_settings(), Verifier::new(&[], None))
            .oneshot(
                Request::builder()
                    .uri("/rathole")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "application/json");
        assert_eq!(headers[header::CACHE_CONTROL], RATHOLE_CACHE_CONTROL);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let served: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            served,
            serde_json::json!({
                "remote_addr": "relay.example.com:7000",
                "transport": "noise",
                "noise_pattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                "public_key": "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=",
                "domain": "relay.example.com",
            })
        );
    }

    fn rathole_settings() -> PublicRatholeSettings {
        PublicRatholeSettings {
            remote_addr: "relay.example.com:2333".to_owned(),
            transport: rathole_settings_rust::Transport::Noise,
            noise_pattern: rathole_settings_rust::NoisePattern::Nk25519ChaChaPolyBlake2s,
            public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
            domain: "relay.example.com".to_owned(),
        }
    }

    fn signing_router() -> axum::Router {
        router(
            rathole_settings(),
            Verifier::new(
                &[Tunnel {
                    name: rathole_settings_rust::TunnelName::parse("alice").unwrap(),
                    token: Secret::new("alice-token"),
                }],
                Some(Secret::new("admin-key")),
            ),
        )
    }

    #[tokio::test]
    async fn me_names_the_signing_tunnel_and_its_public_host() {
        let request = signed_request(
            "GET",
            "https://relay.example.com/me",
            b"",
            "alice",
            "alice-token",
            unix_now().unwrap(),
            "me-round-trip",
        );
        let response = signing_router().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let served: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            served,
            serde_json::json!({
                "tunnel_name": "alice",
                "public_host": "alice.relay.example.com",
            })
        );
    }

    #[tokio::test]
    async fn me_refuses_unsigned_wrongly_signed_and_admin_requests() {
        let now = unix_now().unwrap();
        let unsigned = Request::builder()
            .uri("/me")
            .header(header::HOST, "relay.example.com")
            .body(Body::empty())
            .unwrap();
        let uri = "https://relay.example.com/me";
        for request in [
            unsigned,
            signed_request("GET", uri, b"", "alice", "wrong-token", now, "a"),
            signed_request("GET", uri, b"", "admin", "admin-key", now, "b"),
        ] {
            let response = signing_router().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert!(body.is_empty(), "a 401 carries no detail");
        }
    }

    /// A body over the buffering limit is refused before it is verified.
    #[tokio::test]
    async fn me_refuses_a_body_over_the_limit() {
        let body = vec![b'x'; 64 * 1024 + 1];
        let request = signed_request(
            "GET",
            "https://relay.example.com/me",
            &body,
            "alice",
            "alice-token",
            unix_now().unwrap(),
            "too-big",
        );
        let response = signing_router().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    /// Unknown paths still 404 rather than demanding a signature.
    #[tokio::test]
    async fn unsigned_routes_are_unaffected_by_the_signature_layer() {
        let router = signing_router();
        for (uri, status) in [
            ("/rathole", StatusCode::OK),
            ("/nothing", StatusCode::NOT_FOUND),
        ] {
            let request = Request::builder().uri(uri).body(Body::empty()).unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), status, "{uri}");
        }
    }
}
