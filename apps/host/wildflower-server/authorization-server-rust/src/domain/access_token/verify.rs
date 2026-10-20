//! Verifying an incoming access token: [`verify_access_token`] checks its
//! signature against the configured keys and its `iss`, `aud` and `exp`
//! against [`AccessTokenVerifyOptions`].

use jsonwebtoken::{Algorithm, DecodingKey, Validation};

use super::claims::VerifiedClaims;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::signing_key::{KeyMaterialError, SigningKey};

/// Policy applied to incoming tokens during verification.
pub struct AccessTokenVerifyOptions<'a> {
    /// Required `iss` value.
    pub expected_issuer: &'a str,
    /// Set of `aud` values that pass verification.
    pub accepted_audiences: &'a [String],
}

/// Failures while verifying an access token.
#[derive(Debug, thiserror::Error)]
pub enum AccessTokenVerifyError {
    /// Token did not pass cryptographic or claim validation; surface as 401.
    #[error("token rejected")]
    TokenRejected,
    /// No signing keys are configured — operator misconfiguration, surface as 500.
    #[error("no signing keys configured")]
    NoSigningKeysConfigured,
    /// The signing-key store could not be read (e.g. the database query
    /// failed) — distinct from a key whose material is corrupt. Surface as 500.
    /// Wraps the domain [`AuthorizationServerError`]
    /// the store surfaced, so no database error type appears here.
    #[error("signing-key store unavailable")]
    KeyStoreUnavailable(#[source] AuthorizationServerError),
    /// A configured signing key's material could not be turned into a
    /// `DecodingKey`.
    #[error("signing key material could not be loaded")]
    SigningKeyUnreadable(#[source] KeyMaterialError),
    /// The token verified cryptographically but has since been revoked — its
    /// `jti` is on the denylist, the subject's revocation epoch post-dates
    /// the token's `iat`, or the browser session its `sid` names is revoked. Surface as 401. Distinct from [`Self::TokenRejected`]
    /// so the caller and the logs can tell a revoked token from a bad one.
    #[error("token revoked")]
    Revoked,
    /// The revocation store could not be read (e.g. the database query failed)
    /// while checking whether a token was revoked. An operator problem, and we
    /// **fail closed** — surface as 500 rather than admit a possibly-revoked
    /// token — matching how [`Self::KeyStoreUnavailable`] is treated.
    #[error("revocation store unavailable: {0}")]
    RevocationStoreUnavailable(String),
    /// The browser session a token's `sid` names could not be read while
    /// checking whether it was revoked. Fails closed like
    /// [`Self::RevocationStoreUnavailable`].
    #[error("browser session store unavailable")]
    BrowserSessionStoreUnavailable(#[source] AuthorizationServerError),
}

/// Verify a JWT against `possible_signing_keys`, returning the decoded claims
/// on success.
///
/// If the header carries a `kid` that matches any of the supplied keys, only
/// those keys are tried; otherwise every key is attempted (allowing for
/// rotation overlap).
///
/// # Errors
///
/// Returns [`AccessTokenVerifyError::NoSigningKeysConfigured`] if `possible_signing_keys`
/// is empty, [`AccessTokenVerifyError::SigningKeyUnreadable`] if a candidate key's
/// material cannot be turned into a `DecodingKey`, or
/// [`AccessTokenVerifyError::TokenRejected`] if the token is empty, its header cannot be
/// decoded, or no candidate key validates it.
pub fn verify_access_token(
    token: &str,
    possible_signing_keys: &[SigningKey],
    opts: &AccessTokenVerifyOptions<'_>,
) -> Result<VerifiedClaims, AccessTokenVerifyError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(AccessTokenVerifyError::TokenRejected);
    }
    if possible_signing_keys.is_empty() {
        return Err(AccessTokenVerifyError::NoSigningKeysConfigured);
    }
    let header =
        jsonwebtoken::decode_header(token).map_err(|_| AccessTokenVerifyError::TokenRejected)?;

    let kid = header.kid.as_deref();
    let mut kid_matched = possible_signing_keys
        .iter()
        .filter(move |k| kid.is_some_and(|target| k.kid == target))
        .peekable();
    let mut candidates: Box<dyn Iterator<Item = &SigningKey> + '_> = if kid_matched.peek().is_some()
    {
        Box::new(kid_matched)
    } else {
        Box::new(possible_signing_keys.iter())
    };

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[opts.expected_issuer]);
    let audiences: Vec<&str> = opts.accepted_audiences.iter().map(String::as_str).collect();
    validation.set_audience(&audiences);
    validation.validate_exp = true;

    let try_verifying_with =
        |key: &SigningKey| -> Result<Option<VerifiedClaims>, AccessTokenVerifyError> {
            let dec =
                DecodingKey::try_from(key).map_err(AccessTokenVerifyError::SigningKeyUnreadable)?;
            Ok(
                jsonwebtoken::decode::<VerifiedClaims>(token, &dec, &validation)
                    .ok()
                    .map(|d| d.claims),
            )
        };

    candidates
        .find_map(|key| try_verifying_with(key).transpose())
        .unwrap_or(Err(AccessTokenVerifyError::TokenRejected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::access_token::{mint_access_token, NewAccessTokenArgs};
    use chrono::{Duration, Utc};
    use jsonwebtoken::{EncodingKey, Header};

    /// A token whose issuer isn't the expected one is rejected.
    #[test]
    fn verify_rejects_wrong_issuer() {
        let key = SigningKey::generate().expect("gen");
        let token = mint_access_token(
            &key,
            &NewAccessTokenArgs {
                client_id: "c",
                scopes: &[],
                ttl: Duration::seconds(60),
                issuer: "tauri://localhost",
                audience: None,
                patient: None,
                sid: None,
            },
        )
        .expect("mint");
        let err = verify_access_token(
            &token,
            &[key],
            &AccessTokenVerifyOptions {
                expected_issuer: "tauri://elsewhere",
                accepted_audiences: &["tauri://elsewhere".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(err, AccessTokenVerifyError::TokenRejected));
    }

    /// An empty string is `TokenRejected`, the caller's fault.
    #[test]
    fn verify_rejects_empty_token() {
        let key = SigningKey::generate().expect("gen");
        let err = verify_access_token(
            "",
            &[key],
            &AccessTokenVerifyOptions {
                expected_issuer: "tauri://localhost",
                accepted_audiences: &["tauri://localhost".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(err, AccessTokenVerifyError::TokenRejected));
    }

    /// With no keys to check against, verifying is `NoSigningKeysConfigured`,
    /// the operator's fault, not a rejected token.
    #[test]
    fn verify_rejects_when_no_keys() {
        let err = verify_access_token(
            "a.b.c",
            &[],
            &AccessTokenVerifyOptions {
                expected_issuer: "tauri://localhost",
                accepted_audiences: &["tauri://localhost".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(
            err,
            AccessTokenVerifyError::NoSigningKeysConfigured
        ));
    }

    /// A token that carries no `jti` claim still verifies, surfacing
    /// `jti: None`, so the denylist can't target it individually. Encoded by
    /// hand because `mint_access_token` always writes a `jti`.
    #[test]
    fn verify_accepts_legacy_token_without_jti() {
        let key = SigningKey::generate().expect("gen");
        let origin = "tauri://localhost";
        let now = Utc::now();
        // A claims object with the same shape as a minted token minus `jti`.
        let legacy_claims = serde_json::json!({
            "iss": origin,
            "sub": "legacy-client",
            "aud": origin,
            "exp": (now + Duration::seconds(60)).timestamp(),
            "iat": now.timestamp(),
            "scope": "system/*.read",
        });
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(key.kid.clone());
        let enc = EncodingKey::try_from(&key).expect("encoding key");
        let token = jsonwebtoken::encode(&header, &legacy_claims, &enc).expect("encode legacy");

        let claims = verify_access_token(
            &token,
            &[key],
            &AccessTokenVerifyOptions {
                expected_issuer: origin,
                accepted_audiences: &[origin.to_string()],
            },
        )
        .expect("legacy no-jti token must still verify");
        assert_eq!(claims.jti, None, "a legacy token surfaces no jti");
        assert_eq!(claims.subject, "legacy-client");
    }
}
