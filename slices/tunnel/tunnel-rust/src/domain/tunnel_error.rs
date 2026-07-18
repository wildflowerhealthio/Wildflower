//! [`TunnelError`] — the tunnel domain's failure vocabulary the HTTP layer
//! renders. A stale-revision write is a normal `409` carrying the current
//! snapshot (part of the success type, not an error), so the store surface has
//! no *semantic* failure of its own — only an opaque infrastructure one. The one
//! client-facing failure is [`InsufficientScope`](TunnelError::InsufficientScope):
//! the caller authenticated but their token doesn't cover the `/tunnel` scope
//! (`wildflower/TunnelSettings.{r,u}`), rendered as the shared `403`. The HTTP
//! layer ([`crate::http::errors`]) renders each; the store produces
//! `Infrastructure` without leaking its db/diesel/`r2d2` error types up to the
//! routes, and [`std::error::Error`] lets the composition root fold it into an
//! `anyhow` context chain.

/// The ways a tunnel settings operation can fail — the domain's failure
/// vocabulary. [`InsufficientScope`](TunnelError::InsufficientScope) is a
/// **semantic**, client-facing authorization failure (a `403`);
/// [`Infrastructure`](TunnelError::Infrastructure) is opaque. The cause of the
/// latter is captured as text so this type stays free of the store's
/// db/diesel/`r2d2` error types, and it implements [`std::error::Error`] so the
/// composition root can fold it into an `anyhow` context chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    /// The caller authenticated, but their token doesn't cover the scope the
    /// `/tunnel` surface requires (`wildflower/TunnelSettings.r` to read,
    /// `.u` to replace). Rendered as a `403` naming the missing scope(s) — the
    /// same shape gatekeeper's `/access` and databases' surfaces return. The
    /// `Scoped` extractor renders this shape directly when it rejects; the
    /// variant lets a capability method surface the same failure through the
    /// domain error channel.
    InsufficientScope { missing_scopes: Vec<String> },
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
            TunnelError::InsufficientScope { missing_scopes } => {
                write!(
                    f,
                    "insufficient scope; missing {}",
                    missing_scopes.join(" ")
                )
            }
            TunnelError::Infrastructure { context, source } => write!(f, "{context}: {source}"),
        }
    }
}

impl std::error::Error for TunnelError {}
