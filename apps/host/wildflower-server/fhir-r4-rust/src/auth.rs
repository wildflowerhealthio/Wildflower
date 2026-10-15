//! HFS's bearer auth over this server's own access-token signing keys: the
//! [`AccessTokenSigningKeys`] port the host fills in process, the validator
//! that reads it, and the `(AuthConfig, AuthMiddlewareState)` pair HFS's
//! [`helios_rest::create_app_with_auth`] expects.

use std::sync::Arc;

use async_trait::async_trait;
use helios_audit::{sinks::NullSink, AuditSink, ExclusionFilter};
use helios_auth::error::AuthError;
use helios_auth::{AuthConfig, AuthProvider, Principal, ScopeSet, SessionStore};
use helios_rest::AuthMiddlewareState;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use wildflowerhealthio_token_revocation::RevocationStore;

/// The public half of a key this server signs its access tokens with: an
/// RS256 RSA key, its components base64url-encoded as in an RFC 7517 JWK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessTokenPublicKey {
    /// The key's id, which a token signed with it names in its `kid` header.
    pub kid: String,
    /// The RSA modulus `n`, base64url-encoded.
    pub n: String,
    /// The RSA public exponent `e`, base64url-encoded.
    pub e: String,
}

/// The public halves of the keys this server signs its access tokens with,
/// read in process, so validating a bearer never calls the server over HTTP.
/// The host implements it over its authorization server's key store.
pub trait AccessTokenSigningKeys: Send + Sync + 'static {
    /// Every key that may have signed a live access token, the active one and
    /// those rotated out alike.
    ///
    /// # Errors
    ///
    /// When the keys can't be read.
    fn public_keys(&self) -> anyhow::Result<Vec<AccessTokenPublicKey>>;
}

/// An access token's claims, as HFS's [`Principal`] carries them. The
/// registered claims the [`Validation`] checks (`aud`, `iat`, `nbf`) are
/// dropped from [`Self::other_claims`] rather than carried twice.
#[derive(Deserialize)]
struct AccessTokenClaims {
    sub: String,
    iss: String,
    exp: i64,
    jti: Option<String>,
    scope: Option<String>,
    #[serde(flatten)]
    other_claims: serde_json::Map<String, serde_json::Value>,
}

/// The registered claims [`AccessTokenClaims::other_claims`] leaves out.
const VALIDATED_CLAIMS: &[&str] = &["aud", "iat", "nbf"];

/// HFS's bearer validator: a bearer is a JWT signed with one of
/// [`AccessTokenSigningKeys`]'s keys (picked by its `kid`), with RS256, unexpired,
/// naming this server's origin as both `iss` and `aud`, and naming a subject.
/// Its `scope` becomes the principal's SMART scopes.
struct SigningKeysBearerProvider {
    signing_keys: Arc<dyn AccessTokenSigningKeys>,
    /// The server's bare origin, the one `iss` and the one `aud` accepted.
    server_origin: String,
}

impl SigningKeysBearerProvider {
    /// The key `kid` names, or why there is none to verify with.
    fn decoding_key(&self, kid: &str) -> Result<DecodingKey, AuthError> {
        let public_keys = self.signing_keys.public_keys().map_err(|error| {
            AuthError::InternalError(format!("signing keys read failed: {error:#}"))
        })?;
        let public_key = public_keys
            .iter()
            .find(|public_key| public_key.kid == kid)
            .ok_or_else(|| AuthError::UnknownKid {
                kid: kid.to_owned(),
            })?;
        DecodingKey::from_rsa_components(&public_key.n, &public_key.e).map_err(|error| {
            AuthError::InternalError(format!("signing key {kid} is unreadable: {error}"))
        })
    }

    /// What a token must be beyond its signature.
    fn validation(&self) -> Validation {
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.server_origin]);
        validation.set_audience(&[&self.server_origin]);
        // `set_issuer`/`set_audience` check a claim only when it is present.
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.validate_nbf = true;
        validation
    }
}

#[async_trait]
impl AuthProvider for SigningKeysBearerProvider {
    async fn authenticate(&self, authorization_header: &str) -> Result<Principal, AuthError> {
        let token = authorization_header
            .strip_prefix("Bearer ")
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                AuthError::InvalidTokenFormat(
                    "Authorization header must be `Bearer <token>`".to_owned(),
                )
            })?;
        let header = jsonwebtoken::decode_header(token).map_err(|error| {
            AuthError::InvalidTokenFormat(format!("Failed to decode JWT header: {error}"))
        })?;
        let kid = header
            .kid
            .ok_or_else(|| AuthError::InvalidTokenFormat("JWT header missing 'kid'".to_owned()))?;
        let decoding_key = self.decoding_key(&kid)?;
        let claims =
            jsonwebtoken::decode::<AccessTokenClaims>(token, &decoding_key, &self.validation())
                .map_err(validation_error)?
                .claims;

        let AccessTokenClaims {
            sub,
            iss,
            exp,
            jti,
            scope,
            mut other_claims,
        } = claims;
        // Presence alone passes the required-claim check, so an empty subject
        // would otherwise become an anonymous principal.
        if sub.is_empty() {
            return Err(AuthError::ValidationError("Missing 'sub' claim".to_owned()));
        }
        let expires_at = chrono::DateTime::from_timestamp(exp, 0)
            .ok_or_else(|| AuthError::ValidationError("Invalid 'exp' timestamp".to_owned()))?;
        other_claims.retain(|name, _| !VALIDATED_CLAIMS.contains(&name.as_str()));
        Ok(Principal {
            subject: sub,
            issuer: iss,
            tenant_id: None,
            scopes: scope
                .as_deref()
                .map_or_else(ScopeSet::empty, ScopeSet::parse),
            jti,
            expires_at,
            custom_claims: other_claims,
        })
    }

    fn name(&self) -> &str {
        "signing-keys-bearer"
    }
}

/// A token that failed [`SigningKeysBearerProvider::validation`], as HFS's own
/// validator reports it.
fn validation_error(error: jsonwebtoken::errors::Error) -> AuthError {
    use jsonwebtoken::errors::ErrorKind;
    match error.kind() {
        ErrorKind::ExpiredSignature => AuthError::TokenExpired,
        ErrorKind::InvalidSignature => AuthError::InvalidSignature,
        ErrorKind::InvalidAudience => AuthError::ValidationError("Invalid audience".to_owned()),
        ErrorKind::InvalidIssuer => AuthError::ValidationError("Invalid issuer".to_owned()),
        ErrorKind::InvalidAlgorithm => AuthError::UnsupportedAlgorithm {
            alg: "not RS256".to_owned(),
        },
        ErrorKind::MissingRequiredClaim(claim) => {
            AuthError::ValidationError(format!("Missing required claim: {claim}"))
        }
        _ => AuthError::ValidationError(format!("Token validation failed: {error}")),
    }
}

/// The FHIR-side revocation enforcement point: wraps the bearer validator
/// and rejects a validated token iff its `jti` is on the shared denylist. It
/// never stores, so a multi-use authorization server bearer passes on every call. Only the
/// per-`jti` half — `Principal` has no `iat`, so the epoch half stays with
/// the authorization server's `BearerGate`, which runs first. See "Token revocation on the
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

/// Translate the optional signing keys into the `(AuthConfig, auth_state)`
/// pair HFS's `create_app_with_auth` expects. `None` leaves HFS auth off.
///
/// HFS requires `server_origin`, the bare origin every token this server mints
/// names as its `iss` and `aud`, of every token, so a token another server
/// minted is refused here as well as at the authorization server's gate. See
/// `docs/Origins/Explanation.md`.
///
/// `revocation_store` is the shared denylist the host wires into both this and
/// the authorization server; the returned provider consults it per validated token (see
/// [`RevocationCheckingProvider`]).
///
/// `ui_sessions` is the web UI's session store: HFS treats a same-site request
/// carrying its session cookie and no `Authorization` as the session's bearer.
pub(crate) fn build_auth(
    signing_keys: Option<Arc<dyn AccessTokenSigningKeys>>,
    revocation_store: RevocationStore,
    server_origin: &str,
    ui_sessions: Arc<SessionStore>,
) -> (AuthConfig, Option<Arc<AuthMiddlewareState>>) {
    let Some(signing_keys) = signing_keys else {
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

    let provider = RevocationCheckingProvider {
        inner: SigningKeysBearerProvider {
            signing_keys,
            server_origin: server_origin.to_owned(),
        },
        store: revocation_store,
    };
    let audit_sink: Arc<dyn AuditSink> = Arc::new(NullSink);

    let state = Arc::new(AuthMiddlewareState {
        provider: Arc::new(provider),
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
    use super::{
        build_auth, AccessTokenPublicKey, AccessTokenSigningKeys, RevocationCheckingProvider,
    };
    use async_trait::async_trait;
    use helios_auth::error::AuthError;
    use helios_auth::{AuthProvider, Principal, ScopeSet};
    use wildflowerhealthio_authorization_server::domain::signing_key::SigningKey;
    use wildflowerhealthio_authorization_server::domain::token::{mint_access_token, NewJwtArgs};
    use wildflowerhealthio_token_revocation::RevocationStore;

    /// This server's origin.
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";
    /// Another server's origin.
    const OTHER_ORIGIN: &str = "https://lab.relay.example";

    /// The web UI's session store, for this server.
    fn sessions() -> std::sync::Arc<helios_auth::SessionStore> {
        let origin = url::Url::parse(SERVER_ORIGIN).expect("origin");
        std::sync::Arc::new(helios_auth::SessionStore::new(crate::ui_login_config(
            &origin,
            "fhir-ui-client",
        )))
    }

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

    /// Signing keys that are exactly `public_keys`, or can't be read.
    struct FixedSigningKeys(Option<Vec<AccessTokenPublicKey>>);

    impl AccessTokenSigningKeys for FixedSigningKeys {
        fn public_keys(&self) -> anyhow::Result<Vec<AccessTokenPublicKey>> {
            self.0
                .clone()
                .ok_or_else(|| anyhow::anyhow!("the key store is unreadable"))
        }
    }

    /// `key`'s public half, as the host's key store hands it over.
    fn public_key(key: &SigningKey) -> AccessTokenPublicKey {
        AccessTokenPublicKey {
            kid: key.kid.clone(),
            n: key.values.n.clone(),
            e: key.values.e.clone(),
        }
    }

    #[test]
    fn no_signing_keys_leave_hfs_auth_off() {
        let (config, state) = build_auth(None, store(), SERVER_ORIGIN, sessions());
        assert!(
            !config.enabled,
            "HFS auth must be disabled without signing keys"
        );
        assert!(
            state.is_none(),
            "no AuthMiddlewareState should be built without signing keys"
        );
    }

    #[test]
    fn signing_keys_enable_auth_pinned_to_the_server_origin() {
        let (config, state) = build_auth(
            Some(std::sync::Arc::new(FixedSigningKeys(Some(Vec::new())))),
            store(),
            SERVER_ORIGIN,
            sessions(),
        );

        assert!(config.enabled);
        assert_eq!(config.jwks_url, None, "HFS fetches no JWKS");
        // `iss` = `aud` = the server's origin; see `docs/Origins/Explanation.md`.
        assert_eq!(config.expected_issuer.as_deref(), Some(SERVER_ORIGIN));
        assert_eq!(config.expected_audience.as_deref(), Some(SERVER_ORIGIN));
        let state = state.expect("auth state");
        assert!(
            state.sessions.is_some(),
            "HFS must take a signed-in UI session as its bearer"
        );
    }

    /// HFS's validator as `build_auth` configures it for [`SERVER_ORIGIN`],
    /// over `signing_keys`.
    fn hfs_provider_over(signing_keys: FixedSigningKeys) -> std::sync::Arc<dyn AuthProvider> {
        let (_config, state) = build_auth(
            Some(std::sync::Arc::new(signing_keys)),
            store(),
            SERVER_ORIGIN,
            sessions(),
        );
        state
            .expect("auth is on with signing keys")
            .provider
            .clone()
    }

    /// HFS's validator, trusting only `key`.
    fn hfs_provider_trusting(key: &SigningKey) -> std::sync::Arc<dyn AuthProvider> {
        hfs_provider_over(FixedSigningKeys(Some(vec![public_key(key)])))
    }

    /// An authorization server token signed by `key` naming `issuer` and `audience`.
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
    /// trusts — and one naming another server as only its issuer or audience.
    #[tokio::test]
    async fn hfs_accepts_only_tokens_naming_this_server_as_iss_and_aud() {
        let key = SigningKey::generate().expect("generate a signing key");
        let provider = hfs_provider_trusting(&key);

        let principal = provider
            .authenticate(&bearer(&key, SERVER_ORIGIN, SERVER_ORIGIN))
            .await
            .expect("a token for this server is accepted");
        assert_eq!(principal.issuer, SERVER_ORIGIN);
        assert_eq!(principal.subject, "app");
        assert!(principal.jti.is_some());
        assert_eq!(principal.scopes.raw(), ["patient/*.rs"]);
        assert!(
            !principal.custom_claims.contains_key("aud"),
            "{:?}",
            principal.custom_claims
        );

        for (issuer, audience) in [
            (OTHER_ORIGIN, OTHER_ORIGIN),
            (OTHER_ORIGIN, SERVER_ORIGIN),
            (SERVER_ORIGIN, OTHER_ORIGIN),
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

    /// A token signed with a key the server doesn't hold is refused by its
    /// `kid`, and one forged under a held key's `kid` by its signature.
    #[tokio::test]
    async fn hfs_refuses_a_token_signed_with_a_key_the_server_does_not_hold() {
        let held = SigningKey::generate().expect("generate a signing key");
        let provider = hfs_provider_trusting(&held);
        let other = SigningKey::generate().expect("generate a signing key");

        assert!(matches!(
            provider
                .authenticate(&bearer(&other, SERVER_ORIGIN, SERVER_ORIGIN))
                .await,
            Err(AuthError::UnknownKid { .. })
        ));
        let mut forged = other;
        forged.kid.clone_from(&held.kid);
        assert!(matches!(
            provider
                .authenticate(&bearer(&forged, SERVER_ORIGIN, SERVER_ORIGIN))
                .await,
            Err(AuthError::InvalidSignature)
        ));
    }

    /// Keys that can't be read refuse every token as a server-side failure,
    /// never admitting it.
    #[tokio::test]
    async fn hfs_fails_closed_when_the_signing_keys_cannot_be_read() {
        let key = SigningKey::generate().expect("generate a signing key");
        let provider = hfs_provider_over(FixedSigningKeys(None));

        let error = provider
            .authenticate(&bearer(&key, SERVER_ORIGIN, SERVER_ORIGIN))
            .await
            .expect_err("unreadable keys refuse the token");
        assert!(
            matches!(error, AuthError::InternalError(_)),
            "expected InternalError, got {error:?}"
        );
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
        let conn = wildflowerhealthio_persistence::Connection::open_in_memory().expect("open");
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
