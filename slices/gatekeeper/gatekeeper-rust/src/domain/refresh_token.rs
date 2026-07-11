use chrono::{DateTime, Duration, Utc};

use persistence_rust::JsonColumn;

/// Absolute lifetime of a refresh-token family, measured from the original
/// authorization. Rotation swaps generations but never extends this
/// deadline — past it the client re-runs the authorization flow.
pub const REFRESH_TOKEN_FAMILY_TTL: Duration = Duration::days(90);

/// One authorization's refresh-token lineage (RFC 6749 §6). The family owns
/// every fact shared by all the tokens rotated under it — client, scopes,
/// patient context, and the absolute deadline — so those are stated exactly
/// once. Tokens ([`RefreshToken`]) reference it by `family_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshTokenFamily {
    /// Primary key — lineage id shared by every token descended from one
    /// authorization.
    pub family_id: String,
    /// Client the family was issued to; redemption is rejected for any other.
    pub client_id: String,
    /// Scopes carried forward to every access token minted from this family.
    pub scopes: JsonColumn<Vec<String>>,
    /// SMART-on-FHIR patient context recorded at authorization, if any.
    pub patient: Option<String>,
    /// When the family was created (the original authorization).
    pub issued_at: DateTime<Utc>,
    /// Absolute deadline for the whole family — rotation never extends it;
    /// past this the client must re-run the authorization flow.
    pub expires_at: DateTime<Utc>,
    /// SHA-256 base64url hash of the authorization `code` that minted this
    /// family, or `None` for grants with no authorization code (the
    /// device-code flow). On a detected code replay the family is revoked via
    /// this hash (RFC 6749 §4.1.2 / OAuth 2.1 §4.1.2.1). The plaintext code is
    /// never stored.
    pub authorization_code_hash: Option<String>,
    /// The [`Grant`](crate::domain::grant::Grant) that authorized this family,
    /// for **both** flows — the plumbing a future "revoke exactly this device's
    /// session" ticket keys on. Written at family creation; read by nothing in
    /// v1. `None` when no matching grant was found at exchange time (e.g. a grant
    /// revoked between approval and the token poll). No FK: families outlive
    /// grants by design (expired in place, never deleted).
    pub grant_id: Option<String>,
}

/// One rotation of a refresh token. Presenting the plaintext at `/token`
/// with `grant_type=refresh_token` mints a fresh access token plus this
/// token's successor; the presented token is marked consumed. Replaying a
/// consumed token is treated as theft and revokes the whole
/// [`RefreshTokenFamily`] (OAuth 2.1 rotation semantics).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshToken {
    /// Primary key — SHA-256 base64url digest of the plaintext token. The
    /// plaintext is returned to the client once and never stored.
    pub token_hash: String,
    /// The [`RefreshTokenFamily`] this token belongs to.
    pub family_id: String,
    /// When this token was minted.
    pub issued_at: DateTime<Utc>,
    /// Set when this token is redeemed. `None` means this is the family's
    /// single live token.
    pub consumed_at: Option<DateTime<Utc>>,
}
