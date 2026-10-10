//! [`RequestLogError`] — the request log's failure vocabulary the HTTP layer
//! renders.

use scope_capabilities_rust::MissingScopes;

/// The ways a request-log operation can fail.
/// [`InsufficientScope`](RequestLogError::InsufficientScope) is a **semantic**,
/// client-facing authorization failure (a `403`);
/// [`Infrastructure`](RequestLogError::Infrastructure) is opaque. The HTTP layer
/// (`crate::http::errors`) renders each; the store produces `Infrastructure`
/// without leaking its db/diesel/`r2d2` error types up to the routes, and
/// [`std::error::Error`] lets the writer and the sweep log it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestLogError {
    /// The caller authenticated, but their token doesn't cover
    /// `wildflower/RequestLog.r`. Rendered as a `403` naming the missing
    /// scope(s) — the same shape the other scope-gated surfaces return. The
    /// [`Scoped`](scope_capabilities_rust::Scoped) extractor rejects an
    /// under-scoped caller with this variant (via `From<MissingScopes>`).
    InsufficientScope { missing_scopes: Vec<String> },
    /// An infrastructure failure in the backing store (a pool checkout or query
    /// error, or a row the log could not have written) — opaque to clients: the
    /// HTTP layer logs `context` + `source` and answers an empty 500. The cause
    /// is captured as text so this type stays free of the store's db/`r2d2`
    /// error types.
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

impl RequestLogError {
    /// Wrap an infrastructure failure (a store checkout or query error) as an
    /// opaque [`Infrastructure`](RequestLogError::Infrastructure), capturing
    /// `context` and the cause's `Display` text.
    #[must_use]
    pub fn infrastructure(context: &'static str, source: impl std::fmt::Display) -> Self {
        RequestLogError::Infrastructure {
            context,
            source: source.to_string(),
        }
    }
}

impl std::fmt::Display for RequestLogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RequestLogError::InsufficientScope { missing_scopes } => {
                write!(
                    f,
                    "insufficient scope; missing {}",
                    missing_scopes.join(" ")
                )
            }
            RequestLogError::Infrastructure { context, source } => {
                write!(f, "{context}: {source}")
            }
        }
    }
}

impl std::error::Error for RequestLogError {}

/// The [`Scoped`](scope_capabilities_rust::Scoped) extractor's rejection — the
/// caller's token doesn't cover the capability's required scopes — becomes
/// [`InsufficientScope`](RequestLogError::InsufficientScope), so it reaches the wire
/// through this error's rendering like any other failure.
impl From<MissingScopes> for RequestLogError {
    fn from(missing: MissingScopes) -> Self {
        RequestLogError::InsufficientScope {
            missing_scopes: missing.into_rendered(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::request_log_reader_scopes;

    /// The `Scoped` extractor's rejection for the request-log reader becomes the
    /// domain's `InsufficientScope`, naming the reader's rendered scope.
    #[test]
    fn missing_scopes_become_insufficient_scope() {
        let error = RequestLogError::from(MissingScopes::uncovered(&request_log_reader_scopes()));
        assert_eq!(
            error,
            RequestLogError::InsufficientScope {
                missing_scopes: vec!["wildflower/RequestLog.r".to_owned()],
            }
        );
    }
}
