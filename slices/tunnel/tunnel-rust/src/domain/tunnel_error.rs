//! [`TunnelError`] — the tunnel domain's failure vocabulary the HTTP layer
//! renders. The settings surface has no *semantic*, client-facing failure: a
//! stale-revision write is a normal `409` carrying the current snapshot (part of
//! the success type, not an error), so the only failure a store call can raise
//! is an opaque infrastructure one. `TunnelError` therefore carries a single
//! [`Infrastructure`](TunnelError::Infrastructure) variant, mirroring
//! collector's `RemoteError::Backend`: the store produces it without leaking its
//! db/diesel/`r2d2` error types up to the routes, and the HTTP layer
//! ([`crate::http::errors`]) logs it and answers an empty 500.

/// The ways a tunnel settings operation can fail. Only infrastructure failures
/// exist here — see the module docs for why there is no semantic variant. The
/// cause is captured as text so this type stays free of the store's
/// db/diesel/`r2d2` error types, and it implements [`std::error::Error`] so the
/// composition root can fold it into an `anyhow` context chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    /// An infrastructure failure in the backing store (a pool checkout or query
    /// error) — opaque to clients: the HTTP layer logs `context` + `source` and
    /// answers an empty 500. The cause is captured as text so this type stays
    /// free of the store's db/`r2d2` error types.
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

impl TunnelError {
    /// Wrap an infrastructure failure (a store checkout or query error) as an
    /// opaque [`Infrastructure`](TunnelError::Infrastructure), capturing
    /// `context` and the cause's `Display` text. The store calls this so its
    /// db/`r2d2` error types never reach the HTTP layer.
    #[must_use]
    pub fn infrastructure(context: &'static str, source: impl std::fmt::Display) -> Self {
        TunnelError::Infrastructure {
            context,
            source: source.to_string(),
        }
    }
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TunnelError::Infrastructure { context, source } => write!(f, "{context}: {source}"),
        }
    }
}

impl std::error::Error for TunnelError {}
