//! Bridge between our JWKS-URL config and the
//! `(AuthConfig, AuthMiddlewareState)` pair HFS's
//! [`helios_rest::create_app_with_auth`] expects.

use std::sync::Arc;

use helios_audit::{sinks::NullSink, AuditSink, ExclusionFilter};
use helios_auth::{AuthConfig, DisabledJtiCache, JtiCache, JwksBearerAuthProvider, JwksCache};
use helios_rest::AuthMiddlewareState;
use shared_structures_rust::CANONICAL_ISSUER;

/// Translate an optional JWKS URL into the `(AuthConfig, auth_state)`
/// pair HFS's `create_app_with_auth` expects. `None` leaves HFS auth off.
///
/// The expected `iss` is pinned to [`CANONICAL_ISSUER`] — same value
/// gatekeeper writes into every minted token. The JWKS cache is *not*
/// initial-fetched: gatekeeper's HTTP listener isn't bound yet when this
/// runs, so a blocking fetch would deadlock. HFS's `JwksCache` supports
/// lazy fetching — the first request that needs a signing key triggers a
/// fetch then.
pub(crate) fn build_auth(jwks_url: Option<&str>) -> (AuthConfig, Option<Arc<AuthMiddlewareState>>) {
    let Some(jwks_url) = jwks_url else {
        return (AuthConfig::default(), None);
    };

    let config = AuthConfig {
        enabled: true,
        jwks_url: Some(jwks_url.to_string()),
        expected_issuer: Some(CANONICAL_ISSUER.to_string()),
        // `jti` replay-prevention is off because gatekeeper doesn't write a
        // `jti` claim today (see
        // [token.rs](../../../gatekeeper/gatekeeper-rust/src/domain/token.rs)).
        // Add jti to gatekeeper's mint and flip this to `memory` once that
        // ships.
        jti_backend: "disabled".to_string(),
        ..AuthConfig::default()
    };

    let jwks_cache = Arc::new(JwksCache::new(jwks_url, config.jwks_min_refresh_interval));
    let jti_cache: Arc<dyn JtiCache> = Arc::new(DisabledJtiCache);
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
    use super::build_auth;
    use shared_structures_rust::CANONICAL_ISSUER;

    #[test]
    fn jwks_url_none_leaves_hfs_auth_off() {
        let (config, state) = build_auth(None);
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
        let (config, state) = build_auth(Some(url));

        assert!(config.enabled);
        assert_eq!(config.jwks_url.as_deref(), Some(url));
        // `iss` is pinned to the canonical issuer gatekeeper mints with, so a
        // single `expected_issuer` accepts every gatekeeper-signed token.
        assert_eq!(config.expected_issuer.as_deref(), Some(CANONICAL_ISSUER));
        // `jti` replay-prevention stays off until gatekeeper writes a `jti`
        // claim (see issue #218 / `mint_access_token`).
        assert_eq!(config.jti_backend, "disabled");
        // `aud` is intentionally left unvalidated by HFS: audience binding is
        // enforced by gatekeeper's own bearer gate, not HFS. Asserted so that
        // adding HFS-side audience validation later is a deliberate change.
        assert!(config.expected_audience.is_none());
        assert!(state.is_some());
    }
}
