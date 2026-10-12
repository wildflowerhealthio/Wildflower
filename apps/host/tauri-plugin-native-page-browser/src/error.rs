//! Plugin error type. Serializes to a plain string so it surfaces cleanly to
//! the JS `invoke(...)` rejection. Kept dependency-free (no `thiserror`) to
//! match the workspace's lean host crates.
//!
//! [`Error::InvalidUrl`] is built on every target, since both backends validate
//! through `url_scheme::parse_http_url`. The failure variants are
//! platform-gated so each build has only the one it constructs: an
//! always-present variant that a target never constructs would trip the
//! `dead_code` lint (CI runs clippy with warnings denied).

use serde::{Serialize, Serializer};

/// Errors returned by the native-page-browser plugin command.
#[derive(Debug)]
pub enum Error {
    /// The caller's URL doesn't parse, or isn't `http(s)`. Carries why; no
    /// backend was asked to open it.
    InvalidUrl(String),
    /// The native (Swift/Kotlin) plugin couldn't be registered, or its `open`
    /// failed. Carries the underlying message; only constructed on mobile
    /// targets.
    #[cfg(mobile)]
    PluginInvoke(String),
    /// The OS couldn't open the URL in the default browser. Carries the
    /// opener's message; only constructed on desktop targets.
    #[cfg(desktop)]
    OpenDefaultBrowser(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::InvalidUrl(message) => {
                write!(f, "native page browser can't open this URL: {message}")
            }
            #[cfg(mobile)]
            Error::PluginInvoke(message) => {
                write!(f, "native page browser plugin invocation failed: {message}")
            }
            #[cfg(desktop)]
            Error::OpenDefaultBrowser(message) => {
                write!(
                    f,
                    "native page browser couldn't open the default browser: {message}"
                )
            }
        }
    }
}

impl std::error::Error for Error {}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenience alias for plugin results.
pub type Result<T> = std::result::Result<T, Error>;
