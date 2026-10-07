//! Bridge between our JWKS-URL config and the
//! `(AuthConfig, AuthMiddlewareState)` pair HFS's
//! [`helios_rest::create_app_with_auth`] expects.

use std::sync::Arc;

use async_trait::async_trait;
use helios_audit::{sinks::NullSink, AuditSink, ExclusionFilter};
use helios_auth::error::AuthError;
use helios_auth::{AuthConfig, AuthProvider, JwksBearerAuthProvider, JwksCache, Principal};
use helios_rest::AuthMiddlewareState;
use token_revocation_rust::RevocationStore;

/// The FHIR-side revocation enforcement point: wraps helios's JWKS validator
/// and rejects a validated token iff its `jti` is on the shared denylist. It
/// never stores, so a multi-use gatekeeper bearer passes on every call. Only the
/// per-`jti` half — `Principal` has no `iat`, so the epoch half stays with
/// gatekeeper's `BearerGate`, which runs first. See "Token revocation on the
/// FHIR path" in `docs/Capability Statement.md`.
struct RevocationCheckingProvider<P> {
    inner: P,
    store: RevocationStore,
}

#[async_trait]
impl<P: AuthProvider> AuthProvider for RevocationCheckingProvider<P> {
    async fn authenticate(&self, authorization_header: &str) -> Result<Principal, AuthError> {
        let principal = self.inner.authenticate(authorization_header).await?;
        let Some(jti) = principal.jti.as_deref() else {
            return Ok(principal);
        };
        // A store read failure fails closed — an internal error rejects the
        // request rather than admit a possibly revoked token.
        let revoked = self
            .store
            .is_revoked_by_jti(jti)
            .map_err(|e| AuthError::InternalError(format!("revocation store read failed: {e}")))?;
        if revoked {
            return Err(AuthError::ValidationError("token revoked".to_string()));
        }
        Ok(principal)
    }

    fn name(&self) -> &str {
        self.inner.name()
    }
}

/// Translate an optional JWKS URL into the `(AuthConfig, auth_state)`
/// pair HFS's `create_app_with_auth` expects. `None` leaves HFS auth off.
///
/// `expected_issuer` and `expected_audience` are both `server_origin`, the bare
/// origin every token this server mints names as its `iss` and `aud`: HFS
/// checks both (helios-auth matches `aud` exactly when set), so a token another
/// server minted is refused here as well as at gatekeeper's gate. See
/// `docs/Origins/Explanation.md`.
/// The JWKS cache is *not* initial-fetched: gatekeeper's HTTP listener isn't
/// bound yet when this runs, so a blocking fetch would deadlock. HFS's
/// `JwksCache` supports lazy fetching — the first request that needs a signing
/// key triggers a fetch then.
///
/// `revocation_store` is the shared denylist the host wires into both this and
/// gatekeeper; the returned provider consults it per validated token (see
/// [`RevocationCheckingProvider`]).
pub(crate) fn build_auth(
    jwks_url: Option<&str>,
    revocation_store: RevocationStore,
    server_origin: &str,
) -> (AuthConfig, Option<Arc<AuthMiddlewareState>>) {
    let Some(jwks_url) = jwks_url else {
        return (AuthConfig::default(), None);
    };

    let config = AuthConfig {
        enabled: true,
        jwks_url: Some(jwks_url.to_string()),
        expected_issuer: Some(server_origin.to_string()),
        expected_audience: Some(server_origin.to_string()),
        ..AuthConfig::default()
    };

    let jwks_cache = Arc::new(JwksCache::new(jwks_url, config.jwks_min_refresh_interval));
    let provider = RevocationCheckingProvider {
        inner: JwksBearerAuthProvider::new(jwks_cache, &config),
        store: revocation_store,
    };
    let audit_sink: Arc<dyn AuditSink> = Arc::new(NullSink);

    let state = Arc::new(AuthMiddlewareState {
        provider: Arc::new(provider),
        config: Arc::new(config.clone()),
        audit_sink,
        audit_source_observer: "emr-rust".to_string(),
        audit_exclusion_filter: ExclusionFilter::new(vec![]),
        // FHIR is mounted at a fixed prefix with no tenant path segment.
        tenant_url_routing: false,
        // No web-UI login: every caller presents its own bearer token.
        sessions: None,
    });

    (config, Some(state))
}

#[cfg(test)]
mod tests {
    use super::{build_auth, RevocationCheckingProvider};
    use async_trait::async_trait;
    use axum::routing::get;
    use axum::{Json, Router};
    use gatekeeper_rust::crypto_util::public_jwk::PublicJwk;
    use gatekeeper_rust::domain::signing_key::SigningKey;
    use gatekeeper_rust::domain::token::{mint_access_token, NewJwtArgs};
    use helios_auth::error::AuthError;
    use helios_auth::{AuthProvider, Principal, ScopeSet};
    use token_revocation_rust::RevocationStore;

    /// This server's origin.
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";
    /// Another server's origin.
    const OTHER_ORIGIN: &str = "https://lab.relay.example";

    fn store() -> RevocationStore {
        RevocationStore::open_in_memory().expect("open in-memory revocation store")
    }

    /// Stands in for helios's JWKS validator: accepts any header and hands back
    /// a principal carrying the configured `jti`.
    struct StubProvider {
        jti: Option<String>,
    }

    #[async_trait]
    impl AuthProvider for StubProvider {
        async fn authenticate(&self, _authorization_header: &str) -> Result<Principal, AuthError> {
            Ok(Principal {
                subject: "patient-1".to_string(),
                issuer: SERVER_ORIGIN.to_string(),
                tenant_id: None,
                scopes: ScopeSet::empty(),
                jti: self.jti.clone(),
                expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
                custom_claims: serde_json::Map::new(),
            })
        }

        fn name(&self) -> &str {
            "stub"
        }
    }

    #[test]
    fn jwks_url_none_leaves_hfs_auth_off() {
        let (config, state) = build_auth(None, store(), SERVER_ORIGIN);
        assert!(
            !config.enabled,
            "HFS auth must be disabled when no JWKS URL is configured"
        );
        assert!(
            state.is_none(),
            "no AuthMiddlewareState should be built without a JWKS URL"
        );
    }

    #[test]
    fn jwks_url_some_enables_auth_pinned_to_the_server_origin() {
        let url = "http://127.0.0.1:8080/.well-known/jwks.json";
        let (config, state) = build_auth(Some(url), store(), SERVER_ORIGIN);

        assert!(config.enabled);
        assert_eq!(config.jwks_url.as_deref(), Some(url));
        // `iss` = `aud` = the server's origin; see `docs/Origins/Explanation.md`.
        assert_eq!(config.expected_issuer.as_deref(), Some(SERVER_ORIGIN));
        assert_eq!(config.expected_audience.as_deref(), Some(SERVER_ORIGIN));
        assert!(state.is_some());
    }

    /// HFS's own validator as `build_auth` configures it for [`SERVER_ORIGIN`],
    /// fetching its keys from a local JWKS endpoint that publishes `key`.
    async fn hfs_provider_trusting(key: &SigningKey) -> std::sync::Arc<dyn AuthProvider> {
        let jwks = serde_json::json!({ "keys": [PublicJwk::from(key)] });
        let router = Router::new().route(
            "/.well-known/jwks.json",
            get(move || {
                let jwks = jwks.clone();
                async move { Json(jwks) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a JWKS listener");
        let jwks_url = format!(
            "http://{}/.well-known/jwks.json",
            listener.local_addr().expect("JWKS listener address")
        );
        tokio::spawn(async move { axum::serve(listener, router).await });
        let (_config, state) = build_auth(Some(&jwks_url), store(), SERVER_ORIGIN);
        state.expect("auth is on with a JWKS URL").provider.clone()
    }

    /// A gatekeeper token signed by `key` naming `issuer` and `audience`.
    fn bearer(key: &SigningKey, issuer: &str, audience: &str) -> String {
        let token = mint_access_token(
            key,
            &NewJwtArgs {
                client_id: "app",
                scopes: &["patient/*.rs".to_owned()],
                ttl: chrono::Duration::minutes(5),
                issuer,
                audience: Some(audience),
                patient: None,
            },
        )
        .expect("mint");
        format!("Bearer {token}")
    }

    /// HFS accepts a token whose `iss` and `aud` are this server's origin, and
    /// refuses one another server minted — even signed with a key this server
    /// trusts — one naming another server as only its issuer or audience, and
    /// one whose `aud` is the FHIR base rather than the origin.
    #[tokio::test]
    async fn hfs_accepts_only_tokens_naming_this_server_as_iss_and_aud() {
        let key = SigningKey::generate().expect("generate a signing key");
        let provider = hfs_provider_trusting(&key).await;

        let principal = provider
            .authenticate(&bearer(&key, SERVER_ORIGIN, SERVER_ORIGIN))
            .await
            .expect("a token for this server is accepted");
        assert_eq!(principal.issuer, SERVER_ORIGIN);

        let fhir_base = format!("{SERVER_ORIGIN}/fhir-r4");
        for (issuer, audience) in [
            (OTHER_ORIGIN, OTHER_ORIGIN),
            (OTHER_ORIGIN, SERVER_ORIGIN),
            (SERVER_ORIGIN, OTHER_ORIGIN),
            (SERVER_ORIGIN, fhir_base.as_str()),
        ] {
            assert!(
                matches!(
                    provider.authenticate(&bearer(&key, issuer, audience)).await,
                    Err(AuthError::ValidationError(_))
                ),
                "iss {issuer}, aud {audience} must be refused"
            );
        }
    }

    /// The HFS-side multi-use guard: a live `jti` passes on *every* call (the
    /// provider never stores, so it doesn't turn a multi-use bearer single-use),
    /// and a revoked `jti` is rejected.
    #[tokio::test]
    async fn revocation_provider_is_multi_use_and_denylist_aware() {
        let store = store();
        let provider = RevocationCheckingProvider {
            inner: StubProvider {
                jti: Some("live-jti".to_string()),
            },
            store: store.clone(),
        };

        // A live jti is admitted on repeated calls — NOT single-use.
        for _ in 0..3 {
            let principal = provider
                .authenticate("Bearer t")
                .await
                .expect("a live token must pass on every FHIR request");
            assert_eq!(principal.jti.as_deref(), Some("live-jti"));
        }
        // Once revoked, the same jti is rejected.
        let exp = chrono::Utc::now() + chrono::Duration::hours(1);
        store.revoke_jti("live-jti", exp, "test").expect("revoke");
        assert!(
            provider.authenticate("Bearer t").await.is_err(),
            "a revoked token must be rejected by the HFS provider"
        );
    }

    /// A token without a `jti` has no revocation handle, so the denylist can't
    /// name it; it passes through (the gate's epoch check still covers it).
    #[tokio::test]
    async fn revocation_provider_admits_a_token_without_jti() {
        let provider = RevocationCheckingProvider {
            inner: StubProvider { jti: None },
            store: store(),
        };
        let principal = provider
            .authenticate("Bearer t")
            .await
            .expect("a jti-less token is not on any denylist");
        assert!(principal.jti.is_none());
    }

    /// A store that can't answer must reject, never admit a possibly revoked
    /// token.
    #[tokio::test]
    async fn revocation_provider_fails_closed_when_the_store_read_fails() {
        let conn = persistence_rust::Connection::open_in_memory().expect("open");
        let store = RevocationStore::new(conn.clone()).expect("migrate");
        conn.lock()
            .execute("DROP TABLE revoked_jtis", [])
            .expect("drop the denylist table");
        let provider = RevocationCheckingProvider {
            inner: StubProvider {
                jti: Some("any-jti".to_string()),
            },
            store,
        };

        let err = provider
            .authenticate("Bearer t")
            .await
            .expect_err("an unreadable store must reject the token");
        assert!(
            matches!(err, AuthError::InternalError(_)),
            "expected InternalError, got {err:?}"
        );
    }
}
