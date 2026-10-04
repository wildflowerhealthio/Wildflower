//! The site's axum router: every route the relay serves on its local
//! hostnames.

use std::sync::Arc;

use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Json;
use rathole_settings_rust::PublicRatholeSettings;
use shared_structures_rust::health_check::{health_router, AlwaysHealthy};

/// `GET /rathole` changes only when the relay restarts with a new
/// environment, so clients may reuse it for a few minutes.
const RATHOLE_CACHE_CONTROL: &str = "public, max-age=300";

/// - `GET /health`: `200 {"status":"pass"}` while the relay is up to answer.
/// - `GET /rathole`: `rathole_settings` as JSON, without authentication.
pub(super) fn router(rathole_settings: PublicRatholeSettings) -> axum::Router {
    axum::Router::new()
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

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::settings::RelaySettings;

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

        let response = router(settings.public_rathole_settings())
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
}
