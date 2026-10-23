//! `POST /claim` — a device redeems a claim code for its tunnel — and
//! `POST /access` — a device redeems an access code for a new tunnel.
//!
//! `{"code": "ABCD-EFGH"}` (case and the dash ignored) answers
//! `200 {"tunnel_name", "token", ...}`: the tunnel the code was issued for
//! (see `super::admin`), its token, and the fields of `GET /rathole`, as one
//! [`ClaimedTunnel`], under `Cache-Control: no-store`. The code is burned:
//! it redeems once. Only a tunnel's latest code redeems: issuing another
//! cancels it.
//!
//! The request is not signed: the code is the credential. So that a short
//! code is safe, every failure is one answer, `422` with the plain text
//! `the claim code is unknown, used or expired`, whether the code is
//! malformed, unknown, already redeemed or expired; and every attempt first
//! spends from the [`ClaimLimiter`]'s allowances, the client's and the
//! global one, so an attempt over either is `429` before its body is looked
//! at. The client is the address the connection came from, which the site
//! records for each request (see [`super::Site::serve`]).
//!
//! An unexpired access code sent to `POST /claim` answers `409`, unburned;
//! `POST /access` redeems it for a new tunnel (see "Access codes" in the
//! crate docs). Both routes spend from the same allowances.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Json;
use wildflowerhealthio_kitchen_sink::rate_limit::ClientKey;
use wildflowerhealthio_rathole_settings::{
    AccessRequest, ClaimRequest, ClaimedTunnel, InvalidTunnelName, PublicRatholeSettings,
    TunnelName,
};

use super::claim_limiter::{ClaimLimiter, GLOBAL, MAX_CLIENTS, PER_CLIENT};
use crate::domain::{Tunnel, TunnelError};
use crate::live_bindings::state::TunnelRegistry;
use crate::live_bindings::{LiveAccessCodesRedeemer, LiveClaimCodesRedeemer};
use crate::logging::IDENTIFYING;

/// The largest body `POST /claim` and `POST /access` read: a code, an
/// email and a name are a few hundred bytes.
const MAX_BODY_BYTES: usize = 1024;

/// What `POST /claim` answers over its rate limits.
const RATE_LIMITED: &str = "too many claim attempts; try again later";

/// The routes' state: what redeems each kind of code, the limits on trying,
/// and the settings sent back with a redeemed code.
struct ClaimState {
    redeemer: LiveClaimCodesRedeemer,
    access_redeemer: LiveAccessCodesRedeemer,
    limiter: ClaimLimiter,
    rathole_settings: PublicRatholeSettings,
}

/// `POST /claim` and `POST /access`, redeeming codes from `registry`'s store
/// and answering with `rathole_settings`, under the [`PER_CLIENT`] and
/// [`GLOBAL`] limits.
pub(super) fn router(
    registry: &Arc<TunnelRegistry>,
    rathole_settings: PublicRatholeSettings,
) -> axum::Router {
    let state = ClaimState {
        redeemer: LiveClaimCodesRedeemer::new(registry),
        access_redeemer: LiveAccessCodesRedeemer::new(registry),
        limiter: ClaimLimiter::new(PER_CLIENT, GLOBAL, MAX_CLIENTS),
        rathole_settings,
    };
    axum::Router::new()
        .route("/claim", post(claim))
        .route("/access", post(access))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(Arc::new(state))
}

/// Whether `client` may make an attempt now, spending from its allowance and
/// the global one.
fn admit(state: &ClaimState, client: SocketAddr) -> bool {
    let admitted = state
        .limiter
        .admit(ClientKey::from(client.ip()), Instant::now());
    if !admitted {
        tracing::debug!(target: IDENTIFYING, %client, "claim refused: rate limited");
    }
    admitted
}

/// The limits are checked before the body is decoded, so every attempt
/// counts, however malformed.
async fn claim(
    State(state): State<Arc<ClaimState>>,
    ConnectInfo(client): ConnectInfo<SocketAddr>,
    body: Result<Json<ClaimRequest>, JsonRejection>,
) -> Response {
    if !admit(&state, client) {
        return (StatusCode::TOO_MANY_REQUESTS, RATE_LIMITED).into_response();
    }
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    match state.redeemer.redeem(body.code).await {
        Ok(tunnel) => claimed(tunnel, &state.rathole_settings),
        Err(error) => error.into_response(),
    }
}

/// Limited like [`claim`], from the same allowances.
async fn access(
    State(state): State<Arc<ClaimState>>,
    ConnectInfo(client): ConnectInfo<SocketAddr>,
    body: Result<Json<AccessRequest>, JsonRejection>,
) -> Response {
    if !admit(&state, client) {
        return (StatusCode::TOO_MANY_REQUESTS, RATE_LIMITED).into_response();
    }
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    match state
        .access_redeemer
        .redeem(body.code, body.email, body.tunnel_name)
        .await
    {
        Ok(redeemed) => claimed(redeemed.stored.tunnel, &state.rathole_settings),
        Err(error) => error.into_response(),
    }
}

/// `tunnel` with `rathole_settings`, as a redeemed code answers, never
/// cached.
fn claimed(tunnel: Tunnel, rathole_settings: &PublicRatholeSettings) -> Response {
    let tunnel_name = match TunnelName::parse(tunnel.name) {
        Ok(tunnel_name) => tunnel_name,
        // The reason without the name, which the error carries: this is
        // logged to the journal.
        Err(InvalidTunnelName::NotDnsLabel { .. }) => {
            return TunnelError::infrastructure(
                "a stored tunnel name is invalid",
                "not a lowercase DNS label",
            )
            .into_response()
        }
        Err(InvalidTunnelName::Reserved { .. }) => {
            return TunnelError::infrastructure("a stored tunnel name is invalid", "reserved")
                .into_response()
        }
    };
    let claimed = ClaimedTunnel {
        tunnel_name,
        token: tunnel.token.expose().to_owned(),
        rathole_settings: rathole_settings.clone(),
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(claimed)).into_response()
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    use wildflowerhealthio_rathole_settings::{NoisePattern, Transport};

    use super::*;
    use crate::domain::{ClaimCode, ClaimCodeStore, StoredClaimCode, TunnelStore};
    use crate::live_bindings::{
        LiveAccessCodesIssuer, LiveClaimCodesIssuer, LiveTunnelTokensReissuer, LiveTunnelsCreator,
    };
    use crate::site::signature::unix_now;
    use crate::test_support::{admin, registry, Fixture};

    const ALICE: [u8; 4] = [203, 0, 113, 7];

    fn rathole_settings() -> PublicRatholeSettings {
        PublicRatholeSettings {
            remote_addr: "relay.example.com:2333".to_owned(),
            transport: Transport::Noise,
            noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
            public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
            domain: "relay.example.com".to_owned(),
        }
    }

    /// `POST /claim` from `client` with `body` as it is.
    fn claim_request(client: impl Into<IpAddr>, body: &str) -> Request<Body> {
        let mut request = Request::post("/claim")
            .header(header::HOST, "relay.example.com")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(client.into(), 50_000)));
        request
    }

    fn code_body(code: &str) -> String {
        serde_json::json!({ "code": code }).to_string()
    }

    async fn send(router: &axum::Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, body.to_vec())
    }

    /// The claim router over a registry holding `alice`, and her token.
    async fn router_with_alice() -> (axum::Router, Arc<TunnelRegistry>, String, Fixture) {
        let (registry, fixture) = registry(None).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let alice = creator
            .create("alice@example.com".to_owned(), Some("alice".to_owned()))
            .await
            .unwrap();
        let router = router(&registry, rathole_settings());
        (
            router,
            registry,
            alice.tunnel.token.expose().to_owned(),
            fixture,
        )
    }

    #[tokio::test]
    async fn an_issued_code_redeems_once_for_the_tunnel_and_the_rathole_settings() {
        let (router, registry, alice_token, _fixture) = router_with_alice().await;
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let code = issuer.issue("alice".to_owned()).await.unwrap().code;

        let typed = code.to_string().replace('-', "").to_lowercase();
        let response = router
            .clone()
            .oneshot(claim_request(ALICE, &code_body(&typed)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let claimed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            claimed,
            serde_json::json!({
                "tunnel_name": "alice",
                "token": alice_token,
                "remote_addr": "relay.example.com:2333",
                "transport": "noise",
                "noise_pattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "domain": "relay.example.com",
            })
        );

        let (status, _) = send(&router, claim_request(ALICE, &code_body(&typed))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "burned");
    }

    /// Issuing a second code for a tunnel cancels the first: it answers like
    /// any unknown code, and the second redeems.
    #[tokio::test]
    async fn a_new_code_cancels_the_tunnels_earlier_one() {
        let (router, registry, _, _fixture) = router_with_alice().await;
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let earlier = issuer.issue("alice".to_owned()).await.unwrap().code;
        let later = issuer.issue("alice".to_owned()).await.unwrap().code;

        let (status, _) = send(
            &router,
            claim_request(ALICE, &code_body(&earlier.to_string())),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let (status, _) = send(
            &router,
            claim_request(ALICE, &code_body(&later.to_string())),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    /// A code issued before the tunnel's token was reissued redeems for the
    /// new token.
    #[tokio::test]
    async fn a_code_redeems_for_the_token_reissued_after_it() {
        let (router, registry, alice_token, _fixture) = router_with_alice().await;
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let code = issuer.issue("alice".to_owned()).await.unwrap().code;
        let reissuer: LiveTunnelTokensReissuer = admin(&registry);
        let reissued = reissuer.reissue("alice".to_owned()).await.unwrap();

        let (status, body) =
            send(&router, claim_request(ALICE, &code_body(&code.to_string()))).await;
        assert_eq!(status, StatusCode::OK);
        let claimed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(claimed["token"], reissued.tunnel.token.expose());
        assert_ne!(claimed["token"], alice_token);
    }

    /// Malformed, unknown, used and expired codes get the same status and
    /// body. Each is tried from its own address, so no limit is reached.
    #[tokio::test]
    async fn every_failure_is_answered_alike() {
        let (router, registry, _, _fixture) = router_with_alice().await;
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let used = issuer.issue("alice".to_owned()).await.unwrap().code;
        let (status, _) = send(&router, claim_request(ALICE, &code_body(&used.to_string()))).await;
        assert_eq!(status, StatusCode::OK);
        let expired = ClaimCode::parse("2345-6789").unwrap();
        let now = unix_now().unwrap();
        assert!(registry
            .store
            .replace_claim_code(&StoredClaimCode {
                code_hash: expired.hash(),
                tunnel_name: "alice".to_owned(),
                expires_at: now,
            })
            .unwrap());

        let mut answers = Vec::new();
        for (last, code) in [
            "not a code".to_owned(),
            "ABCD-EFG".to_owned(),
            "WXYZ-WXYZ".to_owned(),
            used.to_string(),
            expired.to_string(),
        ]
        .into_iter()
        .enumerate()
        {
            let client = [192, 0, 2, u8::try_from(last).unwrap()];
            answers.push(send(&router, claim_request(client, &code_body(&code))).await);
        }
        for answer in &answers {
            assert_eq!(
                *answer,
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    b"the claim code is unknown, used or expired".to_vec()
                )
            );
        }
    }

    #[tokio::test]
    async fn one_client_is_limited_to_its_burst_even_when_malformed() {
        let (router, _, _, _fixture) = router_with_alice().await;
        for _ in 0..PER_CLIENT.burst {
            let (status, _) = send(&router, claim_request(ALICE, "not json")).await;
            assert_ne!(status, StatusCode::TOO_MANY_REQUESTS);
        }
        let (status, body) = send(&router, claim_request(ALICE, &code_body("WXYZ-WXYZ"))).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::TOO_MANY_REQUESTS,
                RATE_LIMITED.as_bytes().to_vec()
            )
        );
        let (status, _) = send(&router, claim_request([192, 0, 2, 1], &code_body("x"))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "others still try");
    }

    #[tokio::test]
    async fn every_client_together_is_limited_to_the_global_burst() {
        let (router, registry, _, _fixture) = router_with_alice().await;
        let issuer: LiveClaimCodesIssuer = admin(&registry);
        let code = issuer.issue("alice".to_owned()).await.unwrap().code;
        for last in 0..u8::try_from(GLOBAL.burst).unwrap() {
            let (status, _) =
                send(&router, claim_request([192, 0, 2, last], &code_body("x"))).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        }
        // Over the global limit even a valid code from a fresh client is
        // refused, and stays unburned.
        let fresh = claim_request([198, 51, 100, 1], &code_body(&code.to_string()));
        let (status, _) = send(&router, fresh).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        let redeemer = LiveClaimCodesRedeemer::new(&registry);
        assert!(redeemer.redeem(code.to_string()).await.is_ok());
    }

    /// `POST /access` from `client` with `body`.
    fn access_request(client: impl Into<IpAddr>, body: &serde_json::Value) -> Request<Body> {
        let mut request = claim_request(client, &body.to_string());
        *request.uri_mut() = "/access".parse().unwrap();
        request
    }

    /// An access code sent to `POST /claim` answers `409`, unburned; sent to
    /// `POST /access` with an email and a name it answers the new tunnel
    /// with the rathole settings, once.
    #[tokio::test]
    async fn an_access_code_is_offered_at_claim_and_redeems_at_access() {
        let (router, registry, _, _fixture) = router_with_alice().await;
        let issuer: LiveAccessCodesIssuer = admin(&registry);
        let code = issuer.issue().await.unwrap().code.to_string();

        let (status, body) = send(&router, claim_request(ALICE, &code_body(&code))).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::CONFLICT,
                b"the code is an access code: redeem it at POST /access with an email and a name"
                    .to_vec()
            )
        );

        let body = serde_json::json!({
            "code": code.to_lowercase(),
            "email": "bob@example.com",
            "tunnel_name": "bob",
        });
        let response = router
            .clone()
            .oneshot(access_request(ALICE, &body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let mut claimed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let token = claimed["token"].take();
        let stored = registry
            .store
            .list_tunnels()
            .unwrap()
            .into_iter()
            .find(|stored| stored.tunnel.name == "bob")
            .unwrap();
        assert_eq!(token, stored.tunnel.token.expose());
        assert_eq!(stored.email, "bob@example.com");
        assert_eq!(
            claimed,
            serde_json::json!({
                "tunnel_name": "bob",
                "token": null,
                "remote_addr": "relay.example.com:2333",
                "transport": "noise",
                "noise_pattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                "public_key": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "domain": "relay.example.com",
            })
        );

        let (status, _) = send(&router, access_request(ALICE, &body)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "burned");
        let (status, _) = send(&router, claim_request(ALICE, &code_body(&code))).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "no longer offered"
        );
    }

    /// A bad code is refused alike whatever comes with it; a good code's bad
    /// email or name is refused with its reason, and the code still redeems.
    #[tokio::test]
    async fn access_refusals_name_the_email_or_name_only_for_a_good_code() {
        let (router, registry, _, _fixture) = router_with_alice().await;
        let issuer: LiveAccessCodesIssuer = admin(&registry);
        let code = issuer.issue().await.unwrap().code.to_string();

        let bad_code = serde_json::json!({
            "code": "WXYZ-WXYZ",
            "email": "not an email",
            "tunnel_name": "alice",
        });
        let (status, body) = send(&router, access_request([192, 0, 2, 1], &bad_code)).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                b"the access code is unknown, used or expired".to_vec()
            )
        );
        for (last, email, name, expected) in [
            (
                2,
                "not an email",
                "bob",
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "the email is not an email address",
                ),
            ),
            (
                3,
                "bob@example.com",
                "Bob",
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "the name is not a lowercase DNS label",
                ),
            ),
            (
                4,
                "bob@example.com",
                "alice",
                (StatusCode::CONFLICT, "a tunnel already has the name"),
            ),
        ] {
            let body = serde_json::json!({"code": code, "email": email, "tunnel_name": name});
            let answer = send(&router, access_request([192, 0, 2, last], &body)).await;
            assert_eq!(
                answer,
                (expected.0, expected.1.as_bytes().to_vec()),
                "{name}"
            );
        }
        let without_name = serde_json::json!({"code": code, "email": "bob@example.com"});
        let (status, _) = send(&router, access_request([192, 0, 2, 5], &without_name)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(registry.store.list_tunnels().unwrap().len(), 2);
    }

    /// `POST /claim` and `POST /access` spend from one client allowance.
    #[tokio::test]
    async fn access_and_claim_share_the_limits() {
        let (router, _, _, _fixture) = router_with_alice().await;
        for _ in 0..PER_CLIENT.burst {
            let (status, _) = send(&router, claim_request(ALICE, "not json")).await;
            assert_ne!(status, StatusCode::TOO_MANY_REQUESTS);
        }
        let body = serde_json::json!({"code": "WXYZ-WXYZ", "email": "bob@example.com"});
        let (status, _) = send(&router, access_request(ALICE, &body)).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_refused() {
        let (router, _, _, _fixture) = router_with_alice().await;
        let body = code_body(&"A".repeat(MAX_BODY_BYTES));
        let (status, _) = send(&router, claim_request(ALICE, &body)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }
}
