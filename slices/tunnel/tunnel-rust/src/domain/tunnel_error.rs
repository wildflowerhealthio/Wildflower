//! [`TunnelError`] — the tunnel domain's failure vocabulary the HTTP layer
//! renders. The `/tunnel` read has one failure a client sees:
//! [`InsufficientScope`](TunnelError::InsufficientScope), the caller
//! authenticated but their token doesn't cover `wildflower/TunnelSettings.r`,
//! rendered as the shared `403` by [`crate::http::errors`].

use scope_capabilities_rust::MissingScopes;

/// The ways a tunnel operation can fail — the domain's failure vocabulary.
/// [`InsufficientScope`](TunnelError::InsufficientScope) is a **semantic**,
/// client-facing authorization failure (a `403`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    /// The caller authenticated, but their token doesn't cover the scope the
    /// `/tunnel` surface requires (`wildflower/TunnelSettings.r`). Rendered as a
    /// `403` naming the missing scope(s) — the same shape gatekeeper's `/access`
    /// and databases' surfaces return. The
    /// [`Scoped`](scope_capabilities_rust::Scoped) extractor rejects an
    /// under-scoped caller with this variant (via `From<MissingScopes>`).
    InsufficientScope { missing_scopes: Vec<String> },
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
        }
    }
}

impl std::error::Error for TunnelError {}

/// The [`Scoped`](scope_capabilities_rust::Scoped) extractor's rejection — the
/// caller's token doesn't cover the capability's required scopes — becomes
/// [`InsufficientScope`](TunnelError::InsufficientScope), so it reaches the wire
/// through this error's rendering like any other failure.
impl From<MissingScopes> for TunnelError {
    fn from(missing: MissingScopes) -> Self {
        TunnelError::InsufficientScope {
            missing_scopes: missing.into_rendered(),
        }
    }
}
