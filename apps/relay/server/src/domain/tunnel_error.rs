//! [`TunnelError`] — why a tunnel change was refused or failed. The
//! [`capabilities`](crate::domain::capabilities) and the store speak it; the admin API
//! (`crate::site::admin`) renders each variant to a status and a short
//! plain-text reason, or a logged empty `500` for
//! [`Infrastructure`](TunnelError::Infrastructure). Nothing here knows about
//! HTTP, and the store produces `Infrastructure` without leaking its diesel
//! or `r2d2` error types up to the routes.

/// The ways a tunnel change can fail. Every variant but the last is a
/// **semantic**, client-facing refusal; [`Infrastructure`](Self::Infrastructure)
/// is opaque.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    /// The name is not a lowercase DNS label.
    InvalidName,
    /// The email is empty, too long or not `local@domain`.
    InvalidEmail,
    /// The name is one the relay keeps for itself
    /// ([`FrontSettings::is_reserved`](crate::settings::FrontSettings::is_reserved)).
    Reserved,
    /// A stored tunnel already has the name.
    Taken,
    /// No tunnel has the name.
    NotFound,
    /// No free name is left.
    Exhausted(&'static str),
    /// Storing, reaching rathole or the clock failed — opaque to clients: the admin
    /// API logs `context` + `source` and answers an empty `500`. The cause is
    /// captured as text so this type stays free of the store's diesel /
    /// `r2d2` error types.
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

impl TunnelError {
    /// Wrap an infrastructure failure (a store checkout or query error, a
    /// change rathole did not take, the clock) as an opaque
    /// [`Infrastructure`](Self::Infrastructure), capturing `context` and the
    /// cause's alternate `Display` text (an `anyhow` chain in full).
    #[must_use]
    pub fn infrastructure(context: &'static str, source: impl std::fmt::Display) -> Self {
        TunnelError::Infrastructure {
            context,
            source: format!("{source:#}"),
        }
    }
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TunnelError::InvalidName => f.write_str("the name is not a lowercase DNS label"),
            TunnelError::InvalidEmail => f.write_str("the email is not an email address"),
            TunnelError::Reserved => f.write_str("the name is reserved"),
            TunnelError::Taken => f.write_str("a tunnel already has the name"),
            TunnelError::NotFound => f.write_str("no tunnel has the name"),
            TunnelError::Exhausted(reason) => f.write_str(reason),
            TunnelError::Infrastructure { context, source } => write!(f, "{context}: {source}"),
        }
    }
}

impl std::error::Error for TunnelError {}
