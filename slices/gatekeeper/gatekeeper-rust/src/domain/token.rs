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
mod tests;
