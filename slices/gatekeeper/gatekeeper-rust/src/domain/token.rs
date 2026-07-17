use chrono::serde::{ts_seconds, ts_seconds_option};
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Deserializer, Serialize};

use crate::domain::signing_key::{KeyMaterialError, SigningKey};

/// Lifetime of access tokens minted by the gatekeeper. The consent UI's
/// `offline_access` copy ("Access your data after 15 minutes") states this
/// value — keep the two in step.
pub const ACCESS_TOKEN_TTL: Duration = Duration::minutes(15);

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
    /// Unique JWT ID (RFC 7519 §4.1.7) — a fresh random identifier stamped on
    /// every mint. It is the handle the token-revocation store keys a per-token
    /// denylist on, so a leaked token can be invalidated before its `exp`. Left
    /// as the wire short form `jti` (like `scope`/`patient`) since the name is
    /// itself the canonical spelling.
    pub jti: String,
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
    /// Marks the boot-minted host owner token — the only token `require_auth`
    /// lets authenticate via the canonical audience. A private claim, absent
    /// (never `false`) on every other token. See `docs/Origins/Explanation.md`.
    #[serde(rename = "wf_owner", skip_serializing_if = "Option::is_none")]
    pub host_owner: Option<bool>,
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
    /// Mark the token as the host owner token, adding the `wf_owner` claim that
    /// `require_auth` requires before honouring the canonical audience. Only
    /// [`mint_host_owner_token`](crate::seeding) sets this; every OAuth mint
    /// leaves it `false`.
    pub is_host_owner: bool,
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
        // A fresh random `jti` per mint — generated here, not taken from
        // `NewJwtArgs`, so *every* mint site (the OAuth token response, the boot
        // host-owner token, the refresh/token-exchange path) gets a unique id
        // without having to remember to pass one.
        jti: uuid::Uuid::new_v4().to_string(),
        audience: args.audience.unwrap_or(args.origin).to_string(),
        expires_at: now + args.ttl,
        issued_at: now,
        scope: args.scope.join(" "),
        patient: args.patient.map(str::to_string),
        host_owner: args.is_host_owner.then_some(true),
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
    /// Unique JWT ID (`jti`), if the token carries one. `Option` — and
    /// `#[serde(default)]` — because verification stays tolerant of legacy
    /// tokens minted before gatekeeper wrote a `jti`: they verify fine, they
    /// just can't be denylisted individually (the per-subject epoch still
    /// covers them). Every token gatekeeper mints today carries one.
    #[serde(default)]
    pub jti: Option<String>,
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
    /// Present and `true` only on the host owner token (the `wf_owner` claim);
    /// `require_auth` requires it before accepting the canonical audience.
    #[serde(rename = "wf_owner", default)]
    pub host_owner: Option<bool>,
}

/// Read the caller's authority from the verified `scope` claim so the shared
/// `Scoped` extractor can coverage-check
/// it. Delegates to the one shared claim-string → [`Grant`](scopes_rust::Grant)
/// parse, so this gate and a downstream slice's `ScopeClaims` gate can't
/// disagree on how a claim becomes authority; a missing `scope` claim yields an
/// empty grant (covers nothing) — fail-closed.
impl scope_capabilities_rust::GrantedScopes for VerifiedClaims {
    fn granted(&self) -> scopes_rust::Grant {
        scope_capabilities_rust::grant_from_scope_claim(self.scope.as_deref())
    }
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
    /// Wraps the domain [`GatekeeperError`](crate::domain::gatekeeper_error::GatekeeperError)
    /// the store surfaced, so no database error type appears here.
    #[error("signing-key store unavailable")]
    KeyStoreUnavailable(#[source] crate::domain::gatekeeper_error::GatekeeperError),
    /// A configured signing key's material could not be turned into a
    /// `DecodingKey`.
    #[error("signing key material could not be loaded")]
    SigningKeyUnreadable(#[source] KeyMaterialError),
    /// The token verified cryptographically but has since been revoked — its
    /// `jti` is on the denylist, or the subject's revocation epoch post-dates
    /// the token's `iat`. Surface as 401. Distinct from [`Self::TokenRejected`]
    /// so the caller and the logs can tell a revoked token from a bad one.
    #[error("token revoked")]
    Revoked,
    /// The revocation store could not be read (e.g. the database query failed)
    /// while checking whether a token was revoked. An operator problem, and we
    /// **fail closed** — surface as 500 rather than admit a possibly-revoked
    /// token — matching how [`Self::KeyStoreUnavailable`] is treated.
    #[error("revocation store unavailable")]
    RevocationStoreUnavailable(#[source] rusqlite::Error),
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
            is_host_owner in any::<bool>(),
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
                    is_host_owner,
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
            // The `wf_owner` marker round-trips: present-and-`true` only when minted.
            prop_assert_eq!(verified_claims.host_owner, is_host_owner.then_some(true));

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
                is_host_owner: false,
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

    fn owner_args<'a>(client_id: &'a str, origin: &'a str) -> NewJwtArgs<'a> {
        NewJwtArgs {
            client_id,
            scope: &[],
            ttl: Duration::seconds(60),
            origin,
            audience: None,
            patient: None,
            is_host_owner: false,
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
                let claims = verify_jwt(
                    &token,
                    std::slice::from_ref(key),
                    &VerifyOptions {
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

    /// `verify_jwt` still accepts a legacy token that carries no `jti` claim —
    /// the tolerance that lets tokens minted before this change keep validating
    /// (they surface `jti: None`, so the denylist just can't target them
    /// individually). Encoded by hand because `mint_access_token` always writes
    /// a `jti` now.
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

        let claims = verify_jwt(
            &token,
            &[key],
            &VerifyOptions {
                expected_issuer: origin,
                accepted_audiences: &[origin.to_string()],
            },
        )
        .expect("legacy no-jti token must still verify");
        assert_eq!(claims.jti, None, "a legacy token surfaces no jti");
        assert_eq!(claims.subject, "legacy-client");
    }
}
