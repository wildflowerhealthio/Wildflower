//! [`GatekeeperError`] — the gatekeeper domain's failure vocabulary, modeled on
//! collector's `RemoteError`: a small set of **semantic**, client-facing
//! outcomes plus one opaque infrastructure variant. The HTTP layer
//! ([`crate::http::errors`]) renders each to a status and wire body; nothing
//! here knows about HTTP, and the store ([`crate::db`]) produces
//! [`Backend`](GatekeeperError::Backend) without leaking its database error
//! types up to the routes.

/// The ways a gatekeeper domain operation can fail. The `*NotFound` variants
/// are semantic, client-facing outcomes that are part of the wire contract
/// (each renders as a structured JSON 404 keyed by the resource's identifying
/// field); [`Backend`](GatekeeperError::Backend) is an opaque infrastructure
/// failure rendered as a logged, empty 500.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatekeeperError {
    /// No pending, unexpired authorization-code consent has this id — the
    /// Owner-facing `/access/oauth-consents/{id}` surface's 404.
    OAuthConsentNotFound { id: String },
    /// No pending, unexpired device-code consent has this user code — the
    /// Owner-facing `/access/devices/{userCode}` surface's 404.
    DeviceConsentNotFound { user_code: String },
    /// No standing grant has this id — the `/access/grants/{id}` 404.
    GrantNotFound { id: String },
    /// No authorization request has this id — the `/oauth/authorize/{id}`
    /// polling endpoint's 404.
    AuthorizationRequestNotFound { id: String },
    /// An infrastructure failure in the backing store (a lock, query, or
    /// mapping error) — opaque to clients: the HTTP layer logs `context` +
    /// `source` and answers an empty 500. The cause is captured as text so
    /// this type stays free of the store's database error types.
    Backend {
        context: &'static str,
        source: String,
    },
}

// `Display`/`Error` are hand-written (not `thiserror`-derived) because the
// `Backend` variant deliberately names its field `source` for symmetry with
// collector's `RemoteError`, and `thiserror` would treat that `String` as the
// structured error source (which it cannot be).
impl std::fmt::Display for GatekeeperError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GatekeeperError::OAuthConsentNotFound { id } => {
                write!(f, "no pending oauth consent with id {id}")
            }
            GatekeeperError::DeviceConsentNotFound { user_code } => {
                write!(f, "no pending device consent with user code {user_code}")
            }
            GatekeeperError::GrantNotFound { id } => write!(f, "no grant with id {id}"),
            GatekeeperError::AuthorizationRequestNotFound { id } => {
                write!(f, "no authorization request with id {id}")
            }
            GatekeeperError::Backend { context, source } => write!(f, "{context}: {source}"),
        }
    }
}

impl std::error::Error for GatekeeperError {}

impl GatekeeperError {
    /// Wrap an infrastructure failure (a store lock, query, or row-mapping
    /// error) as an opaque [`Backend`](GatekeeperError::Backend), capturing
    /// `context` and the cause's `Display` text. The store calls this so its
    /// database error types never reach the HTTP layer.
    #[must_use]
    pub fn backend(context: &'static str, source: impl std::fmt::Display) -> Self {
        GatekeeperError::Backend {
            context,
            source: source.to_string(),
        }
    }
}
