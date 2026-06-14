use chrono::serde::{ts_seconds, ts_seconds_option};
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Deserializer, Serialize};

use crate::domain::signing_key::{KeyMaterialError, SigningKey};

/// Normalize the `aud` claim — RFC 7519 lets it be a string or an array of
/// strings — into a single canonical `Vec<String>` so downstream code has one
/// shape to consume.
fn deserialize_audience<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrVec {
        One(String),
        Many(Vec<String>),
    }
    match StringOrVec::deserialize(deserializer)? {
        StringOrVec::One(s) => Ok(vec![s]),
        StringOrVec::Many(v) => Ok(v),
    }
}

/// Claims encoded in an access token minted by the gatekeeper.
///
/// Field names are expanded for readability; serde renames them back to the
/// RFC 7519 short forms on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessTokenClaims {
    /// Origin that issued the token.
    #[serde(rename = "iss")]
    pub issuer: String,
    /// `client_id` the token is bound to.
    #[serde(rename = "sub")]
    pub subject: String,
    /// Resource server the token is intended for.
    #[serde(rename = "aud")]
    pub audience: String,
    /// Instant at which the token stops being valid.
    #[serde(rename = "exp", with = "ts_seconds")]
    pub expires_at: DateTime<Utc>,
    /// Instant at which the token was minted.
    #[serde(rename = "iat", with = "ts_seconds")]
    pub issued_at: DateTime<Utc>,
    /// Space-separated OAuth scopes granted by this token.
    pub scope: String,
    /// Optional SMART-on-FHIR patient context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patient: Option<String>,
}

/// Inputs required to mint a new JWT access token.
pub struct NewJwtArgs<'a> {
    /// OAuth client requesting the token.
    pub client_id: &'a str,
    /// Scopes to embed in the token.
    pub scope: &'a [String],
    /// Duration the token should remain valid from `now`.
    pub ttl: Duration,
    /// Origin minting the token; becomes the `iss` claim and the default `aud`.
    pub origin: &'a str,
    /// Optional explicit audience override; falls back to `origin` when `None`.
    pub audience: Option<&'a str>,
    /// Optional SMART-on-FHIR patient context.
    pub patient: Option<&'a str>,
}

/// Failures while minting an access token.
#[derive(Debug, thiserror::Error)]
pub enum MintError {
    /// The signing key's material could not be turned into an `EncodingKey`.
    #[error("signing key material could not be loaded")]
    SigningKeyUnreadable(#[source] KeyMaterialError),
    /// `jsonwebtoken` failed to encode the JWS.
    #[error("jws encode failed")]
    JwsEncodeFailed(#[from] jsonwebtoken::errors::Error),
}

/// Mint a signed access token using `signing_key` and the supplied claim inputs.
///
/// # Errors
///
/// Returns [`MintError::SigningKeyUnreadable`] if `signing_key`'s material
/// cannot be turned into an `EncodingKey`, or [`MintError::JwsEncodeFailed`]
/// if encoding the JWS fails.
pub fn mint_access_token(
    signing_key: &SigningKey,
    args: &NewJwtArgs<'_>,
) -> Result<String, MintError> {
    let now = Utc::now();
    let claims = AccessTokenClaims {
        issuer: args.origin.to_string(),
        subject: args.client_id.to_string(),
        audience: args.audience.unwrap_or(args.origin).to_string(),
        expires_at: now + args.ttl,
        issued_at: now,
        scope: args.scope.join(" "),
        patient: args.patient.map(str::to_string),
    };
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(signing_key.kid.clone());
    let enc = EncodingKey::try_from(signing_key).map_err(MintError::SigningKeyUnreadable)?;
    jsonwebtoken::encode(&header, &claims, &enc).map_err(MintError::JwsEncodeFailed)
}

/// Claims successfully verified from an incoming JWT.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct VerifiedClaims {
    /// Origin that issued the token (`iss`).
    #[serde(rename = "iss")]
    pub issuer: String,
    /// `client_id` the token is bound to (`sub`).
    #[serde(rename = "sub")]
    pub subject: String,
    /// Audience(s) the token is intended for (`aud`). Normalized at parse time —
    /// a wire-level string is wrapped into a one-element vector.
    #[serde(rename = "aud", deserialize_with = "deserialize_audience")]
    pub audience: Vec<String>,
    /// Expiration instant, if present (`exp`).
    #[serde(rename = "exp", default, with = "ts_seconds_option")]
    pub expires_at: Option<DateTime<Utc>>,
    /// Time the token was minted, if present (`iat`).
    #[serde(rename = "iat", default, with = "ts_seconds_option")]
    pub issued_at: Option<DateTime<Utc>>,
    /// Space-separated scope list, if present.
    #[serde(default)]
    pub scope: Option<String>,
    /// SMART-on-FHIR patient context, if present.
    #[serde(default)]
    pub patient: Option<String>,
}

/// Policy applied to incoming tokens during verification.
pub struct VerifyOptions<'a> {
    /// Required `iss` value.
    pub expected_issuer: &'a str,
    /// Set of `aud` values that pass verification.
    pub accepted_audiences: &'a [String],
}

/// Failures while verifying an access token.
#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    /// Token did not pass cryptographic or claim validation; surface as 401.
    #[error("token rejected")]
    TokenRejected,
    /// No signing keys are configured — operator misconfiguration, surface as 500.
    #[error("no signing keys configured")]
    NoSigningKeysConfigured,
    /// The signing-key store could not be read (e.g. the database query
    /// failed) — distinct from a key whose material is corrupt. Surface as 500.
    #[error("signing-key store unavailable")]
    KeyStoreUnavailable(#[source] rusqlite::Error),
    /// A configured signing key's material could not be turned into a
    /// `DecodingKey`.
    #[error("signing key material could not be loaded")]
    SigningKeyUnreadable(#[source] KeyMaterialError),
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
/// Returns [`VerifyError::NoSigningKeysConfigured`] if `possible_signing_keys`
/// is empty, [`VerifyError::SigningKeyUnreadable`] if a candidate key's
/// material cannot be turned into a `DecodingKey`, or
/// [`VerifyError::TokenRejected`] if the token is empty, its header cannot be
/// decoded, or no candidate key validates it.
pub fn verify_jwt(
    token: &str,
    possible_signing_keys: &[SigningKey],
    opts: &VerifyOptions<'_>,
) -> Result<VerifiedClaims, VerifyError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(VerifyError::TokenRejected);
    }
    if possible_signing_keys.is_empty() {
        return Err(VerifyError::NoSigningKeysConfigured);
    }
    let header = jsonwebtoken::decode_header(token).map_err(|_| VerifyError::TokenRejected)?;

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

    let try_verifying_with = |key: &SigningKey| -> Result<Option<VerifiedClaims>, VerifyError> {
        let dec = DecodingKey::try_from(key).map_err(VerifyError::SigningKeyUnreadable)?;
        Ok(
            jsonwebtoken::decode::<VerifiedClaims>(token, &dec, &validation)
                .ok()
                .map(|d| d.claims),
        )
    };

    candidates
        .find_map(|key| try_verifying_with(key).transpose())
        .unwrap_or(Err(VerifyError::TokenRejected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::signing_key::SigningKey;
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
        ) {
            let key = shared_key();
            let audience: Option<String> = audience_suffix.map(|s| format!("{origin}{s}"));
            let expected_aud = audience.clone().unwrap_or_else(|| origin.clone());

            let before = Utc::now();
            let token = mint_access_token(
                key,
                &NewJwtArgs {
                    client_id: &client_id,
                    scope: &scopes,
                    ttl: Duration::seconds(ttl_seconds),
                    origin: &origin,
                    audience: audience.as_deref(),
                    patient: patient.as_deref(),
                },
            ).expect("mint");

            let verified_claims = verify_jwt(
                &token,
                std::slice::from_ref(key),
                &VerifyOptions {
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
                // Spread verified_claims for timestamps through —
                // they come from `Utc::now()` so we can't predict them
                ..verified_claims
            };
            prop_assert_eq!(&verified_claims, &expected);

            let iat = verified_claims.issued_at.expect("iat present");
            let exp = verified_claims.expires_at.expect("exp present");
            prop_assert_eq!(exp - iat, Duration::seconds(ttl_seconds));
            // JWT timestamps are second-precision; allow a small slack window
            // around the wall-clock `before`/`now` envelope.
            prop_assert!((iat - before).num_seconds().abs() <= 2);
        }
    }

    #[test]
    fn verify_rejects_wrong_issuer() {
        let key = SigningKey::generate().expect("gen");
        let token = mint_access_token(
            &key,
            &NewJwtArgs {
                client_id: "c",
                scope: &[],
                ttl: Duration::seconds(60),
                origin: "tauri://localhost",
                audience: None,
                patient: None,
            },
        )
        .expect("mint");
        let err = verify_jwt(
            &token,
            &[key],
            &VerifyOptions {
                expected_issuer: "tauri://elsewhere",
                accepted_audiences: &["tauri://elsewhere".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(err, VerifyError::TokenRejected));
    }

    #[test]
    fn verify_rejects_empty_token() {
        let key = SigningKey::generate().expect("gen");
        let err = verify_jwt(
            "",
            &[key],
            &VerifyOptions {
                expected_issuer: "tauri://localhost",
                accepted_audiences: &["tauri://localhost".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(err, VerifyError::TokenRejected));
    }

    #[test]
    fn verify_rejects_when_no_keys() {
        let err = verify_jwt(
            "a.b.c",
            &[],
            &VerifyOptions {
                expected_issuer: "tauri://localhost",
                accepted_audiences: &["tauri://localhost".to_string()],
            },
        )
        .unwrap_err();
        assert!(matches!(err, VerifyError::NoSigningKeysConfigured));
    }
}
