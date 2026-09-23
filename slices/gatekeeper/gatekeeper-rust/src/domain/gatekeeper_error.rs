//! [`GatekeeperError`] — the gatekeeper domain's failure vocabulary, modeled on
//! collector's `RemoteError`: a small set of **semantic**, client-facing
//! outcomes plus one opaque infrastructure variant. The HTTP layer
//! ([`crate::http::errors`]) renders each to a status and wire body; nothing
//! here knows about HTTP, and the store ([`crate::db`]) produces
//! [`Infrastructure`](GatekeeperError::Infrastructure) without leaking its
//! database error types up to the routes. The semantic `*NotFound` outcomes are
//! decided one layer up, in `domain::capabilities`, so both the `SQLite`
//! adapter and the in-memory test fake speak only the primitive port contract.

/// The ways a gatekeeper domain operation can fail. The `*NotFound` variants
/// are semantic, client-facing outcomes that are part of the wire contract
/// (each renders as a structured JSON 404 keyed by the resource's identifying
/// field); [`Infrastructure`](GatekeeperError::Infrastructure) is an opaque
/// infrastructure failure rendered as a logged, empty 500.
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
    /// An approver tried to grant a client more than they themselves hold —
    /// the consent approve surfaces' **403**. `approver_missing_scopes` are the rendered
    /// scopes the approval would grant that the approver's own token does not
    /// cover ("you can't delegate more permission than you have"). Semantic and
    /// client-facing: the approver must step up (or narrow their approval).
    InsufficientApproverScope {
        approver_missing_scopes: Vec<String>,
    },
    /// The Owner approved an authorization-code consent whose client is new to
    /// this gatekeeper (or whose redirect / scopes step outside its
    /// registration) without acknowledging that warning — the consent approve
    /// surface's **409**. Semantic and client-facing: the Owner UI must show the
    /// registration warning and send
    /// `acknowledgedRegistration: true`. Nothing is written when it is raised.
    RegistrationNotAcknowledged { id: String },
    /// An infrastructure failure in the backing store (a lock, query, or
    /// mapping error) — opaque to clients: the HTTP layer logs `context` +
    /// `source` and answers an empty 500. The cause is captured as text so
    /// this type stays free of the store's database error types.
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

// `Display`/`Error` are hand-written (not `thiserror`-derived) because the
// `Infrastructure` variant deliberately names its field `source` for symmetry
// with collector's `RemoteError`, and `thiserror` would treat that `String` as
// the structured error source (which it cannot be).
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
            GatekeeperError::InsufficientApproverScope {
                approver_missing_scopes,
            } => {
                write!(
                    f,
                    "approver cannot delegate scopes they do not hold: {}",
                    approver_missing_scopes.join(" ")
                )
            }
            GatekeeperError::RegistrationNotAcknowledged { id } => {
                write!(
                    f,
                    "consent {id} names an unregistered client, redirect, or scope and was \
                     approved without acknowledging it"
                )
            }
            GatekeeperError::Infrastructure { context, source } => {
                write!(f, "{context}: {source}")
            }
        }
    }
}

impl std::error::Error for GatekeeperError {}

impl GatekeeperError {
    /// Wrap an infrastructure failure (a store lock, query, or row-mapping
    /// error) as an opaque
    /// [`Infrastructure`](GatekeeperError::Infrastructure), capturing `context`
    /// and the cause's `Display` text. The store calls this so its database
    /// error types never reach the HTTP layer.
    #[must_use]
    pub fn infrastructure(context: &'static str, source: impl std::fmt::Display) -> Self {
        GatekeeperError::Infrastructure {
            context,
            source: source.to_string(),
        }
    }
}
