//! Plugin error type. Serializes to a plain string so it surfaces cleanly to
//! the JS `invoke(...)` rejection. Kept dependency-free (no `thiserror`) to
//! match the workspace's lean host crates.
//!
//! The variants are platform-gated so each build constructs exactly the one it
//! uses — an always-present variant that a given target never constructs would
//! trip the `dead_code` lint (CI runs clippy with warnings denied).

use serde::{Serialize, Serializer};

/// Errors returned by the native-webview plugin commands.
#[derive(Debug)]
pub enum Error {
    /// The native (Swift/Kotlin) plugin invocation failed. Carries the
    /// underlying message; only constructed on mobile targets.
    #[cfg(mobile)]
    PluginInvoke(String),
    /// A desktop popup operation failed (URL parse, window build/navigate).
    /// Only constructed on desktop targets.
    #[cfg(desktop)]
    Internal(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(mobile)]
            Error::PluginInvoke(message) => {
                write!(f, "native webview plugin invocation failed: {message}")
            }
            #[cfg(desktop)]
            Error::Internal(message) => write!(f, "native webview error: {message}"),
        }
    }
}

impl std::error::Error for Error {}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenience alias for plugin results.
pub type Result<T> = std::result::Result<T, Error>;
