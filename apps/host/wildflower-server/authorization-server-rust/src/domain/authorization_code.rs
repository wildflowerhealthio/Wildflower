//! [`AuthorizationCode`] — the Owner's approval carried from the browser to
//! the app's back end. The browser is sent back to the app's redirect URI with
//! the code in the URL, and the app's back end trades it at `/oauth/token` for
//! tokens. The URL holds only the code, never a token, and the code is worth
//! nothing to anyone who sees it without the app's PKCE verifier. A code lives
//! 60 seconds and is redeemed once.

use chrono::{DateTime, Duration, Utc};
use diesel::prelude::{Insertable, Queryable, Selectable};
use url::Url;

use crate::db::authorization_codes::authorization_codes;
use crate::db::shared::{JsonStrings, UrlText};

/// Lifetime of an `authorization_code`, from issuance (on a standing grant at
/// `/authorize` or the limited page's Continue, or on an Owner's consent
/// approval) to the client redeeming it at `/token` (RFC 6749 §4.1.2 — "MUST
/// be short lived"). A code's `expires_at` is its issue instant plus this, and
/// redemption refuses a code whose `expires_at` is before the moment of
/// redemption.
pub const AUTHORIZATION_CODE_TTL: Duration = Duration::seconds(60);

/// A short-lived single-use authorization code as issued — the opaque `code`
/// plus everything it is bound to (client, redirect, PKCE challenge, granted
/// scopes, patient, expiry). Issued at `/authorize` or on an Owner's approval
/// and redeemed at `/token` (RFC 6749 §4.1.2). The PKCE `code_challenge` is
/// stashed here so the redeemer can prove possession of the matching
/// verifier. Everything the redemption checks is fixed on the code when it is
/// issued. Diesel-mapped 1:1 to the `authorization_codes` table.
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = authorization_codes)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AuthorizationCode {
    /// Opaque single-use value the client presents at `/token` to redeem.
    /// Redemption reads and deletes the row in one statement, so of two
    /// redemptions of the same code only one gets it back.
    pub code: String,
    /// The [`CodeRequest`](crate::domain::authorization_request::code::CodeRequest)
    /// this code answers.
    pub request_id: String,
    /// The client the code was issued to: the only one that may redeem it at
    /// `/token`.
    pub client_id: String,
    /// Redirect URI the client used at `/authorize`; the redeemer must name it
    /// again, exactly, at `/token` (RFC 6749 §4.1.3).
    #[diesel(serialize_as = UrlText, deserialize_as = UrlText)]
    pub redirect_uri: Url,
    /// PKCE S256 challenge captured at `/authorize`; the redeemer must present a `code_verifier` that hashes to this.
    pub code_challenge: String,
    /// What the tokens will carry: the approval, bounded by what the
    /// requesting browser's session holds. May be a strict subset of what was
    /// requested.
    #[diesel(serialize_as = JsonStrings, deserialize_as = JsonStrings)]
    pub granted_scopes: Vec<String>,
    /// The SMART patient the approval named, if any; the tokens carry it as
    /// their `patient` claim.
    pub patient: Option<String>,
    /// When the code was minted.
    pub issued_at: DateTime<Utc>,
    /// Instant after which `/token` redemption is rejected as expired.
    pub expires_at: DateTime<Utc>,
    /// The browser session the code was issued under: the one the
    /// `/authorize` request was made in, not the approver's. The tokens and
    /// refresh family the code earns record it too, so revoking that browser
    /// session ends them.
    pub sid: String,
}
