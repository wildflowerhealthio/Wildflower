//! [`AppError`] — the apps slice's semantic failure vocabulary, the domain
//! counterpart of collector's `RemoteError`. The store and actions speak it; the
//! HTTP layer ([`crate::http::errors`]) renders each variant to a status + wire
//! body (or a logged opaque 500 for
//! [`Infrastructure`](AppError::Infrastructure)). Nothing here knows about HTTP,
//! and the store produces `Infrastructure` without leaking its diesel error types
//! up to the routes.
//!
//! The first eight variants are **semantic**, client-facing outcomes that are
//! part of the wire contract; [`Infrastructure`](AppError::Infrastructure) is an
//! opaque infrastructure failure (a pool checkout / query error) answered as an
//! empty 500 — the operator sees the detail, the client doesn't.

/// The ways an apps operation can fail.
#[derive(Debug)]
pub enum AppError {
    /// 404 — no app has this id.
    NotFound { id: String },
    /// 409 — the app exists but isn't editable/removable through the surface a
    /// mutation used (a system app, a seeded self-hosted app, or a body whose
    /// provenance doesn't match the stored app).
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
    /// An infrastructure failure in the backing store (a pool checkout or query
    /// error) — opaque to clients: the HTTP layer logs `context` + `source` and
    /// answers an empty 500. The cause is captured as text so this type stays
    /// free of the store's diesel/`anyhow` error types.
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::NotFound { id } => write!(f, "no app has id {id}"),
            AppError::NotEditable { id } => write!(f, "app {id} is not editable"),
            AppError::Unauthorized => f.write_str("unauthorized"),
            AppError::InvalidUrl { message } => write!(f, "invalid url: {message}"),
            AppError::InvalidName { message } => write!(f, "invalid name: {message}"),
            AppError::InvalidZip { message } => write!(f, "invalid zip: {message}"),
            AppError::Unavailable { reason } => write!(f, "launch unavailable: {reason}"),
            AppError::InvalidHomeScreen { message } => write!(f, "invalid home screen: {message}"),
            AppError::Infrastructure { context, source } => write!(f, "{context}: {source}"),
        }
    }
}

impl std::error::Error for AppError {}

impl AppError {
    /// Wrap an infrastructure failure (a store checkout or query error) as an
    /// opaque [`Infrastructure`](AppError::Infrastructure), capturing `context`
    /// and the cause's `Display` text. The store calls this so its diesel error
    /// types never reach the HTTP layer.
    #[must_use]
    pub fn infrastructure(context: &'static str, source: impl std::fmt::Display) -> Self {
        AppError::Infrastructure {
            context,
            source: source.to_string(),
        }
    }
}

/// A diesel error from a store query or transaction becomes an opaque
/// [`Infrastructure`](AppError::Infrastructure), so store query bodies can `?`
/// diesel calls (and `conn.transaction` closures can carry `AppError`) without
/// naming diesel at the route seam.
impl From<diesel::result::Error> for AppError {
    fn from(error: diesel::result::Error) -> Self {
        AppError::infrastructure("apps store query failed", error)
    }
}
