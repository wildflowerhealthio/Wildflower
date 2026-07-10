//! Bridge between our JWKS-URL config and the
//! `(AuthConfig, AuthMiddlewareState)` pair HFS's
//! [`helios_rest::create_app_with_auth`] expects.

use std::sync::Arc;

use async_trait::async_trait;
use helios_audit::{sinks::NullSink, AuditSink, ExclusionFilter};
use helios_auth::error::AuthError;
use helios_auth::{AuthConfig, JtiCache, JwksBearerAuthProvider, JwksCache};
use helios_rest::AuthMiddlewareState;
use shared_structures_rust::CANONICAL_ISSUER;
use token_revocation_rust::RevocationStore;

/// The FHIR-side revocation enforcement point: a `helios_auth::JtiCache` that
/// treats a validated token's `jti` as a **revocation handle**, not a one-shot
/// nonce. helios calls `check_and_store` once per validated token that carries a
/// `jti`, expecting `Ok(true)` to mean "reject". So this reports a replay iff
/// the `jti` is on the shared denylist — and it **never stores**. A gatekeeper
/// access token is a multi-use bearer (one `wf_auth` cookie reused across many
/// FHIR calls); a store-on-first-sight cache (helios's `memory` backend) would
/// `401` every FHIR request after the first, which is why we supply our own.
///
/// helios only hands this `(jti, expires_at)` — never `sub`/`iat` — so it can
/// enforce only the per-`jti` half. The per-subject *epoch* half needs those
/// claims and is enforced by gatekeeper's `BearerGate`, which fronts every
/// `/fhir-r4/*` request and runs *before* HFS. This is defense-in-depth behind
/// that gate.
struct RevocationJtiCache {
    store: RevocationStore,
}

#[async_trait]
impl JtiCache for RevocationJtiCache {
    async fn check_and_store(
        &self,
        jti: &str,
        _expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<bool, AuthError> {
        // `Ok(true)` = reject (revoked); `Ok(false)` = allow. Never stores, so a
        // live token passes on every call. A store read failure fails closed —
        // an internal error rejects the request rather than admit a possibly
        // revoked token.
        self.store
            .is_revoked_by_jti(jti)
            .map_err(|e| AuthError::InternalError(format!("revocation store read failed: {e}")))
    }
}

/// Translate an optional JWKS URL into the `(AuthConfig, auth_state)`
/// pair HFS's `create_app_with_auth` expects. `None` leaves HFS auth off.
///
/// `expected_issuer` = [`CANONICAL_ISSUER`]; see `docs/Origins/Explanation.md`.
/// The JWKS cache is *not* initial-fetched: gatekeeper's HTTP listener isn't
/// bound yet when this runs, so a blocking fetch would deadlock. HFS's
/// `JwksCache` supports lazy fetching — the first request that needs a signing
/// key triggers a fetch then.
///
/// `revocation_store` is the shared denylist the host wires into both this and
/// gatekeeper; the returned provider consults it per validated token (see
/// [`RevocationJtiCache`]).
pub(crate) fn build_auth(
    jwks_url: Option<&str>,
    revocation_store: RevocationStore,
) -> (AuthConfig, Option<Arc<AuthMiddlewareState>>) {
    let Some(jwks_url) = jwks_url else {
        return (AuthConfig::default(), None);
    };

    let config = AuthConfig {
        enabled: true,
        jwks_url: Some(jwks_url.to_string()),
        expected_issuer: Some(CANONICAL_ISSUER.to_string()),
        // Inert for our construction path: `jti_backend` only selects a cache in
        // helios's own env-driven factory, which we bypass — we build the
        // provider directly with our custom `RevocationJtiCache` below. Left as
        // `"disabled"` so nothing reads it as a request to spin up helios's
        // store-on-first-sight `memory` backend (which would break multi-use
        // bearers — see [`RevocationJtiCache`]).
        jti_backend: "disabled".to_string(),
        ..AuthConfig::default()
    };

    let jwks_cache = Arc::new(JwksCache::new(jwks_url, config.jwks_min_refresh_interval));
    let jti_cache: Arc<dyn JtiCache> = Arc::new(RevocationJtiCache {
        store: revocation_store,
    });
    let provider = JwksBearerAuthProvider::new(jwks_cache, jti_cache, &config);
    let audit_sink: Arc<dyn AuditSink> = Arc::new(NullSink);

    let state = Arc::new(AuthMiddlewareState {
        provider: Arc::new(provider),
        config: Arc::new(config.clone()),
        audit_sink,
        audit_source_observer: "emr-rust".to_string(),
        audit_exclusion_filter: ExclusionFilter::new(vec![]),
    });

    (config, Some(state))
}

#[cfg(test)]
mod tests {
    use super::{build_auth, RevocationJtiCache};
    use helios_auth::JtiCache;
    use shared_structures_rust::CANONICAL_ISSUER;
    use token_revocation_rust::RevocationStore;

    fn store() -> RevocationStore {
        RevocationStore::open_in_memory().expect("open in-memory revocation store")
    }

    #[test]
    fn jwks_url_none_leaves_hfs_auth_off() {
        let (config, state) = build_auth(None, store());
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
    fn jwks_url_some_enables_auth_pinned_to_canonical_issuer() {
        let url = "http://127.0.0.1:8080/.well-known/jwks.json";
        let (config, state) = build_auth(Some(url), store());

        assert!(config.enabled);
        assert_eq!(config.jwks_url.as_deref(), Some(url));
        // `iss` = `CANONICAL_ISSUER`; see `docs/Origins/Explanation.md`.
        assert_eq!(config.expected_issuer.as_deref(), Some(CANONICAL_ISSUER));
        // `jti_backend` is inert here — we pass a custom `RevocationJtiCache`
        // explicitly, bypassing helios's env factory. Left `"disabled"` so
        // nothing spins up helios's single-use `memory` backend.
        assert_eq!(config.jti_backend, "disabled");
        // `aud` left unvalidated by HFS (gatekeeper's bearer gate enforces it).
        // Asserted so adding HFS-side audience validation later is deliberate.
        assert!(config.expected_audience.is_none());
        assert!(state.is_some());
    }

    /// The HFS-side multi-use guard: a live `jti` passes on *every* call (the
    /// cache never stores, so it doesn't turn a multi-use bearer single-use),
    /// and a revoked `jti` is reported as a replay so HFS rejects it.
    #[tokio::test]
    async fn revocation_jti_cache_is_multi_use_and_denylist_aware() {
        let store = store();
        let cache = RevocationJtiCache {
            store: store.clone(),
        };
        let exp = chrono::Utc::now() + chrono::Duration::hours(1);

        // A live jti is allowed (`Ok(false)`) on repeated calls — NOT single-use.
        for _ in 0..3 {
            assert!(
                !cache.check_and_store("live-jti", exp).await.expect("check"),
                "a live token must pass on every FHIR request"
            );
        }
        // Once revoked, the same jti is reported as a replay (`Ok(true)`).
        store.revoke_jti("live-jti", exp, "test").expect("revoke");
        assert!(
            cache.check_and_store("live-jti", exp).await.expect("check"),
            "a revoked token must be rejected by the HFS cache"
        );
    }
}
