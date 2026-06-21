//! Plugin error type. Serializes to a plain string so it surfaces cleanly to
//! the JS `invoke(...)` rejection. Kept dependency-free (no `thiserror`) to
//! match the workspace's lean host crates.

use serde::{Serialize, Serializer};

/// Errors returned by the native-webview plugin commands.
#[derive(Debug)]
pub enum Error {
    /// The native popup is only implemented on iOS today. Desktop keeps the
    /// multi-window Tauri `WebviewWindow` path; Android keeps the existing
    /// sniffer `WebviewWindow`.
    UnsupportedPlatform,
    /// The native (Swift) plugin invocation failed. Carries the underlying
    /// message; only constructed on mobile targets.
    #[cfg(mobile)]
    PluginInvoke(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::UnsupportedPlatform => {
                write!(f, "native webview popups are only supported on iOS")
            }
            #[cfg(mobile)]
            Error::PluginInvoke(message) => {
                write!(f, "native webview plugin invocation failed: {message}")
            }
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
