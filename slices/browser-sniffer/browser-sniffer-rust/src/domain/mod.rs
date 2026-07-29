//! Core types for the `/sniffer` surface: the [`SnifferWebviewHandle`] host
//! port, the [`WebViewSourcePayload`] wire union and its validation, the
//! [`SnifferEvents`] stream seam, the typed page-directed messages, the
//! [`SnifferError`] failure vocabulary, and the scope-gated
//! [`capabilities`](self::capabilities) the handlers acquire. Port-only — no
//! axum, no Tauri.

pub mod capabilities;
pub mod events;
pub(crate) mod page_messages;
mod sniffer_error;
#[cfg(test)]
pub(crate) mod test_fake;
mod web_view_source;
mod webview_handle;

pub use events::SnifferEvents;
pub use page_messages::PageActionPayload;
pub use sniffer_error::SnifferError;
pub use web_view_source::{resolve_source, SourceResolveError, UriSource, WebViewSourcePayload};
pub use webview_handle::SnifferWebviewHandle;
