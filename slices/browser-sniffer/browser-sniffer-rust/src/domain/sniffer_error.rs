//! [`SnifferError`] — the `/sniffer` surface's failure vocabulary. The HTTP
//! layer (`http::errors`) renders it onto the wire; handlers just `?`.

use super::SourceResolveError;

/// Everything a `/sniffer` operation can fail with.
#[derive(Debug)]
pub enum SnifferError {
    /// The submitted `WebViewSource` was rejected (non-http(s) or unparseable
    /// URI, or the unsupported `Html` variant) — 400. Under the retired bridge
    /// this was a warn-and-drop; HTTP gives the client a real acknowledgement.
    InvalidSource { message: String },
    /// The caller's token doesn't cover the operation's `wildflower/Sniffer.*`
    /// scope — 403, rendered through the shared `insufficient_scope` helper.
    InsufficientScope { missing_scopes: Vec<String> },
    /// A host/plugin failure — logged, answered as an opaque 500.
    Infrastructure {
        context: &'static str,
        source: anyhow::Error,
    },
}

impl From<SourceResolveError> for SnifferError {
    fn from(error: SourceResolveError) -> Self {
        SnifferError::InvalidSource {
            message: error.to_string(),
        }
    }
}
