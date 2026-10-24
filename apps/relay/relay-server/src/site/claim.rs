//! `POST /claim` — a device redeems a claim code for a tunnel.
//!
//! `{"code": "ABCD-EFGH"}` (case and the dash ignored) answers
//! `200 {"tunnel_name", "token", ...}`: the tunnel the code was issued for
//! (see `super::admin`), its token, and the fields of `GET /rathole`, as one
//! [`ClaimedTunnel`], under `Cache-Control: no-store`. The code is burned:
//! it redeems once. Only a tunnel's latest code redeems: issuing another
//! cancels it.
//!
//! A code that names no tunnel answers `409`, unburned, when sent alone; sent
//! with `"details": {"email", "tunnel_name"}` (`tunnel_name` optional) it
//! redeems for a new tunnel under them, answered the same way (see "Claim
//! codes" in the crate docs). Details sent with a code that names its tunnel
//! are `422`, unburned.
//!
//! The request is not signed: the code is the credential. So that a short
//! code is safe, every failure of the code is one answer, `422` with the
//! plain text `the claim code is unknown, used or expired`, whether the code
//! is malformed, unknown, already redeemed or expired, whatever details come
//! with it; and every attempt first spends from the [`ClaimLimiter`]'s
//! allowances, the client's and the global one, so an attempt over either is
//! `429` before its body is looked at. The client is the address the
//! connection came from, which the site records for each request (see
//! [`super::Site::serve`]).

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
    ClaimRequest, ClaimedTunnel, InvalidTunnelName, PublicRatholeSettings, TunnelName,
};

use super::claim_limiter::{ClaimLimiter, GLOBAL, MAX_CLIENTS, PER_CLIENT};
use crate::domain::{Tunnel, TunnelError};
use crate::live_bindings::state::TunnelRegistry;
use crate::live_bindings::LiveClaimCodesRedeemer;
use crate::logging::IDENTIFYING;

/// The largest body `POST /claim` reads: a code, an email and a name are a
/// few hundred bytes.
const MAX_BODY_BYTES: usize = 1024;

/// What `POST /claim` answers over its rate limits.
const RATE_LIMITED: &str = "too many claim attempts; try again later";

/// The route's state: what redeems a code, the limits on trying, and the
/// settings sent back with a redeemed code.
struct ClaimState {
    redeemer: LiveClaimCodesRedeemer,
    limiter: ClaimLimiter,
    rathole_settings: PublicRatholeSettings,
}

/// `POST /claim`, redeeming codes from `registry`'s store
/// and answering with `rathole_settings`, under the [`PER_CLIENT`] and
/// [`GLOBAL`] limits.
pub(super) fn router(
    registry: &Arc<TunnelRegistry>,
    rathole_settings: PublicRatholeSettings,
) -> axum::Router {
    let state = ClaimState {
        redeemer: LiveClaimCodesRedeemer::new(registry),
        limiter: ClaimLimiter::new(PER_CLIENT, GLOBAL, MAX_CLIENTS),
        rathole_settings,
    };
    axum::Router::new()
        .route("/claim", post(claim))
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
    match state.redeemer.redeem(body.code, body.details).await {
        Ok(redeemed) => claimed(redeemed.tunnel(), &state.rathole_settings),
        Err(error) => error.into_response(),
    }
}

/// `tunnel` with `rathole_settings`, as a redeemed code answers, never
/// cached.
fn claimed(tunnel: &Tunnel, rathole_settings: &PublicRatholeSettings) -> Response {
    let tunnel_name = match TunnelName::parse(tunnel.name.clone()) {
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
    use crate::domain::{ClaimCode, ClaimCodeStore, ClaimCodeTarget, StoredClaimCode, TunnelStore};
    use crate::live_bindings::{
        LiveClaimCodesIssuer, LiveTunnelTokensReissuer, LiveTunnelsCreator,
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

    /// The code for `alice` that `registry`'s admin issues.
    async fn issue_for_alice(registry: &Arc<TunnelRegistry>) -> ClaimCode {
        let issuer: LiveClaimCodesIssuer = admin(registry);
        issuer
            .issue(ClaimCodeTarget::Preset {
                tunnel_name: "alice".to_owned(),
            })
            .await
            .unwrap()
            .code
    }

    /// A code naming no tunnel that `registry`'s admin issues, as typed.
    async fn issue_open(registry: &Arc<TunnelRegistry>) -> String {
        let issuer: LiveClaimCodesIssuer = admin(registry);
        issuer
            .issue(ClaimCodeTarget::Open)
            .await
            .unwrap()
            .code
            .to_string()
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
        let code = issue_for_alice(&registry).await;

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
        let earlier = issue_for_alice(&registry).await;
        let later = issue_for_alice(&registry).await;

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
        let code = issue_for_alice(&registry).await;
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
        let used = issue_for_alice(&registry).await;
        let (status, _) = send(&router, claim_request(ALICE, &code_body(&used.to_string()))).await;
        assert_eq!(status, StatusCode::OK);
        let expired = ClaimCode::parse("2345-6789").unwrap();
        let now = unix_now().unwrap();
        assert!(registry
            .store
            .insert_claim_code(&StoredClaimCode {
                code_hash: expired.hash(),
                target: ClaimCodeTarget::Preset {
                    tunnel_name: "alice".to_owned(),
                },
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
        let code = issue_for_alice(&registry).await;
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
        assert!(redeemer.redeem(code.to_string(), None).await.is_ok());
    }

    /// `{"code", "details"}` for `code` and `details`.
    fn details_body(code: &str, details: serde_json::Value) -> String {
        serde_json::json!({ "code": code, "details": details }).to_string()
    }

    /// A code naming no tunnel, sent alone, answers `409`, unburned; sent
    /// with an email and a name it answers the new tunnel with the rathole
    /// settings, once.
    #[tokio::test]
    async fn an_open_code_asks_for_details_then_redeems_for_a_new_tunnel() {
        let (router, registry, _, _fixture) = router_with_alice().await;
        let code = issue_open(&registry).await;

        let (status, body) = send(&router, claim_request(ALICE, &code_body(&code))).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::CONFLICT,
                b"the claim code names no tunnel: send it with an email and, optionally, a name"
                    .to_vec()
            )
        );

        let body = details_body(
            &code.to_lowercase(),
            serde_json::json!({ "email": "bob@example.com", "tunnel_name": "bob" }),
        );
        let response = router
            .clone()
            .oneshot(claim_request(ALICE, &body))
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

        for body in [body, code_body(&code)] {
            let (status, _) = send(&router, claim_request(ALICE, &body)).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "burned");
        }
    }

    /// Details sent with a code that names its tunnel are refused, and the
    /// code still redeems sent alone.
    #[tokio::test]
    async fn a_preset_code_refuses_details() {
        let (router, registry, _, _fixture) = router_with_alice().await;
        let code = issue_for_alice(&registry).await.to_string();
        let body = details_body(&code, serde_json::json!({ "email": "bob@example.com" }));
        let (status, body) = send(&router, claim_request(ALICE, &body)).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                b"the claim code names its tunnel: send it without an email or a name".to_vec()
            )
        );
        let (status, _) = send(&router, claim_request(ALICE, &code_body(&code))).await;
        assert_eq!(status, StatusCode::OK);
    }

    /// A bad code is refused alike whatever comes with it; a good open
    /// code's bad email or name is refused with its reason, and the code
    /// still redeems.
    #[tokio::test]
    async fn detail_refusals_name_the_email_or_name_only_for_a_good_code() {
        let (router, registry, _, _fixture) = router_with_alice().await;
        let code = issue_open(&registry).await;

        let bad_code = details_body(
            "WXYZ-WXYZ",
            serde_json::json!({ "email": "not an email", "tunnel_name": "alice" }),
        );
        let (status, body) = send(&router, claim_request([192, 0, 2, 1], &bad_code)).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                b"the claim code is unknown, used or expired".to_vec()
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
            let body = details_body(
                &code,
                serde_json::json!({ "email": email, "tunnel_name": name }),
            );
            let answer = send(&router, claim_request([192, 0, 2, last], &body)).await;
            assert_eq!(
                answer,
                (expected.0, expected.1.as_bytes().to_vec()),
                "{name}"
            );
        }
        let without_name = details_body(&code, serde_json::json!({ "email": "bob@example.com" }));
        let (status, _) = send(&router, claim_request([192, 0, 2, 5], &without_name)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(registry.store.list_tunnels().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_refused() {
        let (router, _, _, _fixture) = router_with_alice().await;
        let body = code_body(&"A".repeat(MAX_BODY_BYTES));
        let (status, _) = send(&router, claim_request(ALICE, &body)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }
}
