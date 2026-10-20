//! Minting an access token: [`mint_access_token`] signs the claims
//! [`NewAccessTokenArgs`] describe with one signing key.

use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header};

use super::claims::AccessTokenClaims;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::signing_key::{KeyMaterialError, SigningKey};

/// Inputs required to mint a new JWT access token.
pub struct NewAccessTokenArgs<'a> {
    /// OAuth client requesting the token.
    pub client_id: &'a str,
    /// Scopes to embed in the token.
    pub scopes: &'a [String],
    /// Duration the token should remain valid from `now`.
    pub ttl: Duration,
    /// The `iss` claim, and the default `aud`.
    pub issuer: &'a str,
    /// Optional explicit audience override; falls back to `issuer` when `None`.
    pub audience: Option<&'a str>,
    /// Optional SMART-on-FHIR patient context.
    pub patient: Option<&'a str>,
    /// The browser session the token is minted under, if any.
    pub sid: Option<&'a str>,
}

/// Failures while minting an access token.
#[derive(Debug, thiserror::Error)]
pub enum AccessTokenMintError {
    /// The signing key's material could not be turned into an `EncodingKey`.
    #[error("signing key material could not be loaded")]
    SigningKeyUnreadable(#[source] KeyMaterialError),
    /// `jsonwebtoken` failed to encode the JWS.
    #[error("jws encode failed")]
    JwsEncodeFailed(#[from] jsonwebtoken::errors::Error),
}

/// The ways minting can fail. `NoActiveSigningKey` is an operator problem
/// (bootstrap has not run, or the key store was tampered with); `Signing` is a
/// key-material or encoding failure from [`mint_access_token`].
#[derive(Debug, thiserror::Error)]
pub(crate) enum AccessTokenIssuanceError {
    #[error("no active signing key in store")]
    NoActiveSigningKey,
    #[error("sign access token")]
    Signing(#[from] AccessTokenMintError),
    #[error(transparent)]
    Store(#[from] AuthorizationServerError),
}

/// Mint a signed access token using `signing_key` and the supplied claim inputs.
///
/// # Errors
///
/// Returns [`AccessTokenMintError::SigningKeyUnreadable`] if `signing_key`'s material
/// cannot be turned into an `EncodingKey`, or [`AccessTokenMintError::JwsEncodeFailed`]
/// if encoding the JWS fails.
pub fn mint_access_token(
    signing_key: &SigningKey,
    args: &NewAccessTokenArgs<'_>,
) -> Result<String, AccessTokenMintError> {
    let now = Utc::now();
    let claims = AccessTokenClaims {
        issuer: args.issuer.to_string(),
        subject: args.client_id.to_string(),
        // A fresh random `jti` per mint — generated here, not taken from
        // `NewAccessTokenArgs`, so *every* mint site (the OAuth token response, the
        // refresh/token-exchange path) gets a unique id
        // without having to remember to pass one.
        jti: uuid::Uuid::new_v4().to_string(),
        audience: args.audience.unwrap_or(args.issuer).to_string(),
        expires_at: now + args.ttl,
        issued_at: now,
        scope: args.scopes.join(" "),
        patient: args.patient.map(str::to_string),
        sid: args.sid.map(str::to_string),
    };
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(signing_key.kid.clone());
    let enc =
        EncodingKey::try_from(signing_key).map_err(AccessTokenMintError::SigningKeyUnreadable)?;
    jsonwebtoken::encode(&header, &claims, &enc).map_err(AccessTokenMintError::JwsEncodeFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::access_token::{
        verify_access_token, AccessTokenVerifyOptions, VerifiedClaims,
    };
    use proptest::prelude::*;
    use std::sync::OnceLock;

    fn shared_key() -> &'static SigningKey {
        static KEY: OnceLock<SigningKey> = OnceLock::new();
        KEY.get_or_init(|| SigningKey::generate().expect("gen"))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn mint_and_verify_round_trip(
            client_id in "[a-zA-Z0-9_-]{1,32}",
            scopes in prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
            ttl_seconds in 1i64..=3600,
            origin in "https://[a-z]{3,16}\\.[a-z]{2,8}",
            audience_suffix in prop::option::of("/[a-z]{2,16}"),
            patient in prop::option::of("[a-zA-Z0-9-]{1,32}"),
            sid in prop::option::of("[a-zA-Z0-9-]{1,36}"),
        ) {
            let key = shared_key();
            let audience: Option<String> = audience_suffix.map(|s| format!("{origin}{s}"));
            let expected_aud = audience.clone().unwrap_or_else(|| origin.clone());

            let before = Utc::now();
            let token = mint_access_token(
                key,
                &NewAccessTokenArgs {
                    client_id: &client_id,
                    scopes: &scopes,
                    ttl: Duration::seconds(ttl_seconds),
                    issuer: &origin,
                    audience: audience.as_deref(),
                    patient: patient.as_deref(),
                    sid: sid.as_deref(),
                },
            ).expect("mint");

            let verified_claims = verify_access_token(
                &token,
                std::slice::from_ref(key),
                &AccessTokenVerifyOptions {
                    expected_issuer: &origin,
                    accepted_audiences: std::slice::from_ref(&expected_aud),
                },
            ).expect("verify");

            // Compare the whole struct so a Debug diff names every wrong field at once.
            let expected = VerifiedClaims {
                issuer: origin.clone(),
                subject: client_id.clone(),
                audience: vec![expected_aud],
                scope: Some(scopes.join(" ")),
                patient: patient.clone(),
                sid: sid.clone(),
                // `jti` is a fresh random id we can't predict, so mirror what
                // was minted; asserted non-empty separately below. Cloned (not
                // spread) because `Option<String>` isn't `Copy` — a bare
                // `..verified_claims` would partially move it and break the
                // `&verified_claims` comparison that follows.
                jti: verified_claims.jti.clone(),
                // Spread verified_claims for timestamps through —
                // they come from `Utc::now()` so we can't predict them
                ..verified_claims
            };
            prop_assert_eq!(&verified_claims, &expected);
            // Every mint stamps a non-empty `jti` (uniqueness is covered by
            // `each_mint_carries_a_unique_jti`).
            prop_assert!(verified_claims.jti.as_deref().is_some_and(|jti| !jti.is_empty()));

            let iat = verified_claims.issued_at.expect("iat present");
            let exp = verified_claims.expires_at.expect("exp present");
            prop_assert_eq!(exp - iat, Duration::seconds(ttl_seconds));
            // JWT timestamps are second-precision; allow a small slack window
            // around the wall-clock `before`/`now` envelope.
            prop_assert!((iat - before).num_seconds().abs() <= 2);
        }
    }

    fn owner_args<'a>(client_id: &'a str, origin: &'a str) -> NewAccessTokenArgs<'a> {
        NewAccessTokenArgs {
            client_id,
            scopes: &[],
            ttl: Duration::seconds(60),
            issuer: origin,
            audience: None,
            patient: None,
            sid: None,
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        /// Every mint stamps a distinct `jti`: minting the *same* inputs twice
        /// must still yield two different ids (the id is random, not derived
        /// from the claims). This is the property the per-token denylist relies
        /// on — two live tokens can't collide on one revocation handle.
        #[test]
        fn each_mint_carries_a_unique_jti(
            client_id in "[a-zA-Z0-9_-]{1,32}",
            origin in "https://[a-z]{3,16}\\.[a-z]{2,8}",
            mints in 2usize..=16,
        ) {
            let key = shared_key();
            let mut seen = std::collections::HashSet::new();
            for _ in 0..mints {
                let token = mint_access_token(key, &owner_args(&client_id, &origin)).expect("mint");
                let claims = verify_access_token(
                    &token,
                    std::slice::from_ref(key),
                    &AccessTokenVerifyOptions {
                        expected_issuer: &origin,
                        accepted_audiences: std::slice::from_ref(&origin),
                    },
                )
                .expect("verify");
                let jti = claims.jti.expect("minted token carries a jti");
                prop_assert!(!jti.is_empty(), "jti must be non-empty");
                prop_assert!(seen.insert(jti), "jti must be unique across mints");
            }
        }
    }
}
