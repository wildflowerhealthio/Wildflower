//! Plugin error type. Serializes to a plain string so it surfaces cleanly to
//! the JS `invoke(...)` rejection. Kept dependency-free (no `thiserror`) to
//! match the workspace's lean host crates.
//!
//! The variants are platform-gated so each build constructs exactly the one it
//! uses — an always-present variant that a given target never constructs would
//! trip the `dead_code` lint (CI runs clippy with warnings denied).

use serde::{Serialize, Serializer};

/// Errors returned by the native-page-browser plugin command.
#[derive(Debug)]
pub enum Error {
    /// The native (Swift/Kotlin) plugin invocation failed, or the URL was
    /// rejected before it. Carries the underlying message; only constructed on
    /// mobile targets.
    #[cfg(mobile)]
    PluginInvoke(String),
    /// The URL was rejected, or the default browser couldn't be opened. Only
    /// constructed on desktop targets.
    #[cfg(desktop)]
    Internal(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(mobile)]
            Error::PluginInvoke(message) => {
                write!(f, "native page browser plugin invocation failed: {message}")
            }
            #[cfg(desktop)]
            Error::Internal(message) => write!(f, "native page browser error: {message}"),
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
