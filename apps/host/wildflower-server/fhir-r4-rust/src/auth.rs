//! HFS's bearer auth over the host's access-token verifier: the
//! [`AccessTokenVerifier`] port the host fills in process, the provider that
//! turns a verified token into HFS's [`Principal`], and the
//! `(AuthConfig, AuthMiddlewareState)` pair HFS's
//! [`helios_rest::create_app_with_auth`] expects.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use helios_audit::{sinks::NullSink, AuditSink, ExclusionFilter};
use helios_auth::error::AuthError;
use helios_auth::{AuthConfig, AuthProvider, Principal, ScopeSet, SessionStore};
use helios_rest::AuthMiddlewareState;

/// What a verified access token says about its bearer, as far as HFS reads
/// it: who the token was issued to, by whom, until when, and with which
/// scopes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAccessToken {
    /// The client the token was issued to (`sub`).
    pub subject: String,
    /// The origin that issued it (`iss`).
    pub issuer: String,
    /// Its id (`jti`), when it carries one.
    pub jti: Option<String>,
    /// When it expires (`exp`).
    pub expires_at: DateTime<Utc>,
    /// Its space-separated SMART scopes (`scope`), when it carries any.
    pub scope: Option<String>,
}

/// Why an access token wasn't verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessTokenVerifyError {
    /// The token doesn't pass: a bad signature, expired, naming another
    /// server, revoked. The bearer is unauthenticated.
    Rejected(String),
    /// The verifier couldn't decide, its keys or revocation records being
    /// unreadable. The request fails rather than admit the token.
    VerifierFailed(String),
}

/// Verifies this server's access tokens, in process: signature, expiry,
/// `iss` and `aud` both the server's origin, and revocation. The host
/// implements it over its authorization server's own verifier, so HFS
/// applies exactly the policy the authorization server's gates do.
pub trait AccessTokenVerifier: Send + Sync + 'static {
    /// Verify `token`, the bearer's raw JWT.
    ///
    /// # Errors
    ///
    /// [`AccessTokenVerifyError::Rejected`] for a token that doesn't pass,
    /// [`AccessTokenVerifyError::VerifierFailed`] when it can't be checked.
    fn verify(&self, token: &str) -> Result<VerifiedAccessToken, AccessTokenVerifyError>;
}

/// HFS's bearer provider: hands the bearer to [`AccessTokenVerifier`] and
/// maps a verified token to HFS's [`Principal`]. A rejected token is an
/// authentication failure; a verifier that can't decide is an internal error,
/// so the request is refused, never admitted.
struct VerifyingBearerProvider {
    verifier: Arc<dyn AccessTokenVerifier>,
}

#[async_trait]
impl AuthProvider for VerifyingBearerProvider {
    async fn authenticate(&self, authorization_header: &str) -> Result<Principal, AuthError> {
        let token = authorization_header
            .strip_prefix("Bearer ")
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                AuthError::InvalidTokenFormat(
                    "Authorization header must be `Bearer <token>`".to_owned(),
                )
            })?;
        let verified = self.verifier.verify(token).map_err(|error| match error {
            AccessTokenVerifyError::Rejected(reason) => AuthError::ValidationError(reason),
            AccessTokenVerifyError::VerifierFailed(error) => AuthError::InternalError(error),
        })?;
        Ok(principal(verified))
    }

    fn name(&self) -> &str {
        "access-token-verifier"
    }
}

/// HFS's principal for a verified token. HFS reads its subject, issuer and
/// scopes; it carries no tenant (FHIR is served at a fixed root) and no other
/// claims, which HFS doesn't read.
fn principal(verified: VerifiedAccessToken) -> Principal {
    Principal {
        subject: verified.subject,
        issuer: verified.issuer,
        tenant_id: None,
        scopes: verified
            .scope
            .as_deref()
            .map_or_else(ScopeSet::empty, ScopeSet::parse),
        jti: verified.jti,
        expires_at: verified.expires_at,
        custom_claims: serde_json::Map::new(),
    }
}

/// Translate the optional verifier into the `(AuthConfig, auth_state)` pair
/// HFS's `create_app_with_auth` expects. `None` leaves HFS auth off.
///
/// `server_origin` is the bare origin every token this server mints names as
/// its `iss` and `aud`; HFS's config records it, and the verifier checks it.
/// See `docs/Origins/Explanation.md`.
///
/// `ui_sessions` is the web UI's session store: HFS treats a same-site request
/// carrying its session cookie and no `Authorization` as the session's bearer.
pub(crate) fn build_auth(
    verifier: Option<Arc<dyn AccessTokenVerifier>>,
    server_origin: &str,
    ui_sessions: Arc<SessionStore>,
) -> (AuthConfig, Option<Arc<AuthMiddlewareState>>) {
    let Some(verifier) = verifier else {
        return (AuthConfig::default(), None);
    };

    // No `jwks_url`: HFS's own JWKS validator isn't used, the provider below
    // is.
    let config = AuthConfig {
        enabled: true,
        expected_issuer: Some(server_origin.to_string()),
        expected_audience: Some(server_origin.to_string()),
        ..AuthConfig::default()
    };

    let audit_sink: Arc<dyn AuditSink> = Arc::new(NullSink);
    let state = Arc::new(AuthMiddlewareState {
        provider: Arc::new(VerifyingBearerProvider { verifier }),
        config: Arc::new(config.clone()),
        audit_sink,
        audit_source_observer: "fhir-r4-rust".to_string(),
        audit_exclusion_filter: ExclusionFilter::new(vec![]),
        // FHIR is mounted at a fixed prefix with no tenant path segment.
        tenant_url_routing: false,
        sessions: Some(ui_sessions),
    });

    (config, Some(state))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use helios_auth::error::AuthError;
    use helios_auth::AuthProvider;

    use super::{build_auth, AccessTokenVerifier, AccessTokenVerifyError, VerifiedAccessToken};

    /// This server's origin.
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";

    /// The web UI's session store, for this server.
    fn sessions() -> Arc<helios_auth::SessionStore> {
        let origin = url::Url::parse(SERVER_ORIGIN).expect("origin");
        Arc::new(helios_auth::SessionStore::new(crate::ui_login_config(
            &origin,
            "fhir-ui-client",
        )))
    }

    /// A verifier that answers every token the same way, recording the tokens
    /// it was handed.
    struct FixedVerifier {
        answer: Result<VerifiedAccessToken, AccessTokenVerifyError>,
        tokens: Mutex<Vec<String>>,
    }

    impl AccessTokenVerifier for FixedVerifier {
        fn verify(&self, token: &str) -> Result<VerifiedAccessToken, AccessTokenVerifyError> {
            self.tokens.lock().expect("tokens").push(token.to_owned());
            self.answer.clone()
        }
    }

    fn fixed(answer: Result<VerifiedAccessToken, AccessTokenVerifyError>) -> Arc<FixedVerifier> {
        Arc::new(FixedVerifier {
            answer,
            tokens: Mutex::new(Vec::new()),
        })
    }

    fn verified() -> VerifiedAccessToken {
        VerifiedAccessToken {
            subject: "app".to_owned(),
            issuer: SERVER_ORIGIN.to_owned(),
            jti: Some("jti-1".to_owned()),
            expires_at: chrono::DateTime::from_timestamp(2_000_000_000, 0).expect("a time"),
            scope: Some("patient/*.rs openid".to_owned()),
        }
    }

    /// HFS's provider as `build_auth` configures it, over `verifier`.
    fn provider_over(verifier: Arc<FixedVerifier>) -> Arc<dyn AuthProvider> {
        let (_config, state) = build_auth(Some(verifier), SERVER_ORIGIN, sessions());
        state.expect("auth is on with a verifier").provider.clone()
    }

    #[test]
    fn no_verifier_leaves_hfs_auth_off() {
        let (config, state) = build_auth(None, SERVER_ORIGIN, sessions());
        assert!(
            !config.enabled,
            "HFS auth must be disabled without a verifier"
        );
        assert!(state.is_none());
    }

    #[test]
    fn a_verifier_enables_auth_pinned_to_the_server_origin() {
        let (config, state) = build_auth(Some(fixed(Ok(verified()))), SERVER_ORIGIN, sessions());

        assert!(config.enabled);
        assert_eq!(config.jwks_url, None, "HFS fetches no JWKS");
        // `iss` = `aud` = the server's origin; see `docs/Origins/Explanation.md`.
        assert_eq!(config.expected_issuer.as_deref(), Some(SERVER_ORIGIN));
        assert_eq!(config.expected_audience.as_deref(), Some(SERVER_ORIGIN));
        assert!(
            state.expect("auth state").sessions.is_some(),
            "HFS must take a signed-in UI session as its bearer"
        );
    }

    /// The bearer's token goes to the verifier, and a verified token becomes
    /// a principal with its subject, issuer, `jti`, expiry and scopes.
    #[tokio::test]
    async fn a_verified_token_becomes_its_principal() {
        let verifier = fixed(Ok(verified()));
        let principal = provider_over(verifier.clone())
            .authenticate("Bearer the-token")
            .await
            .expect("a verified token is accepted");

        assert_eq!(*verifier.tokens.lock().expect("tokens"), ["the-token"]);
        assert_eq!(principal.subject, "app");
        assert_eq!(principal.issuer, SERVER_ORIGIN);
        assert_eq!(principal.jti.as_deref(), Some("jti-1"));
        assert_eq!(principal.expires_at, verified().expires_at);
        assert_eq!(principal.scopes.raw(), ["patient/*.rs", "openid"]);
        assert_eq!(principal.tenant_id, None);
        assert!(principal.custom_claims.is_empty());
    }

    /// A rejected token is an authentication failure.
    #[tokio::test]
    async fn a_rejected_token_is_unauthenticated() {
        let rejected = fixed(Err(AccessTokenVerifyError::Rejected(
            "token revoked".to_owned(),
        )));
        assert!(matches!(
            provider_over(rejected).authenticate("Bearer t").await,
            Err(AuthError::ValidationError(reason)) if reason == "token revoked"
        ));
    }

    /// A verifier that can't decide refuses the request as an internal error,
    /// never admitting the token.
    #[tokio::test]
    async fn a_verifier_failure_fails_closed() {
        let failing = fixed(Err(AccessTokenVerifyError::VerifierFailed(
            "key store unavailable".to_owned(),
        )));
        assert!(matches!(
            provider_over(failing).authenticate("Bearer t").await,
            Err(AuthError::InternalError(_))
        ));
    }

    /// Anything but a non-empty `Bearer` token is refused before the verifier.
    #[tokio::test]
    async fn a_header_without_a_bearer_token_is_refused_unverified() {
        let verifier = fixed(Ok(verified()));
        let provider = provider_over(verifier.clone());
        for header in ["Basic abc", "Bearer ", ""] {
            assert!(
                matches!(
                    provider.authenticate(header).await,
                    Err(AuthError::InvalidTokenFormat(_))
                ),
                "{header:?}"
            );
        }
        assert!(verifier.tokens.lock().expect("tokens").is_empty());
    }
}
