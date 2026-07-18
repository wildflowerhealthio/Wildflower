//! [`AppsError`] — the apps slice's semantic failure vocabulary, the domain
//! counterpart of collector's `RemoteError`. The store and actions speak it; the
//! HTTP layer ([`crate::http::errors`]) renders each variant to a status + wire
//! body (or a logged opaque 500 for
//! [`Infrastructure`](AppsError::Infrastructure)). Nothing here knows about HTTP,
//! and the store produces `Infrastructure` without leaking its diesel error types
//! up to the routes.
//!
//! Every variant but the last is a **semantic**, client-facing outcome that is
//! part of the wire contract; [`Infrastructure`](AppsError::Infrastructure) is an
//! opaque infrastructure failure (a pool checkout / query error) answered as an
//! empty 500 — the operator sees the detail, the client doesn't.

/// The ways an apps operation can fail.
#[derive(Debug)]
pub enum AppsError {
    /// 404 — no app has this id.
    NotFound { id: String },
    /// 409 — the app exists but isn't editable/removable: a system app, or a
    /// seeded self-hosted app. (A per-kind path given an id of another kind is a
    /// `404` instead — the kind mismatch can't be expressed.)
    NotEditable { id: String },
    /// 401 — a loopback launch whose caller didn't pass the owner-auth gate.
    Unauthorized,
    /// 400 — the submitted URL (or self-hosted launch path) failed the write-side
    /// validator.
    InvalidUrl { message: String },
    /// 400 — the submitted name was empty / unusable.
    InvalidName { message: String },
    /// 400 — the uploaded bundle couldn't be extracted (not a zip, over the
    /// size/entry caps, or a path-traversal entry).
    InvalidZip { message: String },
    /// 503 — the launch can't resolve a reachable target (forwarded launch with
    /// no public host, or a `requires_tunnel` app while the tunnel is down).
    Unavailable { reason: String },
    /// 400 — the `PUT /home-screen` body wasn't an exact permutation of the
    /// registry (missing / duplicated / unknown id).
    InvalidHomeScreen { message: String },
    /// 403 — the caller authenticated, but their token doesn't cover the
    /// scope(s) the operation requires (a scope-gated admin surface, or a
    /// per-app SMART launch check). `missing_scopes` are the rendered scopes the
    /// caller must additionally hold; the HTTP layer delegates to the shared
    /// [`scope_capabilities_rust::insufficient_scope`] body.
    InsufficientScope { missing_scopes: Vec<String> },
    /// An infrastructure failure in the backing store (a pool checkout or query
    /// error) — opaque to clients: the HTTP layer logs `context` + `source` and
    /// answers an empty 500. The cause is captured as text so this type stays
    /// free of the store's diesel/`anyhow` error types.
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

impl std::fmt::Display for AppsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppsError::NotFound { id } => write!(f, "no app has id {id}"),
            AppsError::NotEditable { id } => write!(f, "app {id} is not editable"),
            AppsError::Unauthorized => f.write_str("unauthorized"),
            AppsError::InvalidUrl { message } => write!(f, "invalid url: {message}"),
            AppsError::InvalidName { message } => write!(f, "invalid name: {message}"),
            AppsError::InvalidZip { message } => write!(f, "invalid zip: {message}"),
            AppsError::Unavailable { reason } => write!(f, "launch unavailable: {reason}"),
            AppsError::InvalidHomeScreen { message } => write!(f, "invalid home screen: {message}"),
            AppsError::InsufficientScope { missing_scopes } => {
                write!(
                    f,
                    "insufficient scope: missing {}",
                    missing_scopes.join(" ")
                )
            }
            AppsError::Infrastructure { context, source } => write!(f, "{context}: {source}"),
        }
    }
}

impl std::error::Error for AppsError {}

impl AppsError {
    /// Wrap an infrastructure failure (a store checkout or query error) as an
    /// opaque [`Infrastructure`](AppsError::Infrastructure), capturing `context`
    /// and the cause's `Display` text. The store calls this so its diesel error
    /// types never reach the HTTP layer.
    #[must_use]
    pub fn infrastructure(context: &'static str, source: impl std::fmt::Display) -> Self {
        AppsError::Infrastructure {
            context,
            source: source.to_string(),
        }
    }
}

/// A diesel error from a store query or transaction becomes an opaque
/// [`Infrastructure`](AppsError::Infrastructure), so store query bodies can `?`
/// diesel calls (and `conn.transaction` closures can carry `AppsError`) without
/// naming diesel at the route seam.
impl From<diesel::result::Error> for AppsError {
    fn from(error: diesel::result::Error) -> Self {
        AppsError::infrastructure("apps store query failed", error)
    }
}
