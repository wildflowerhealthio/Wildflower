//! Shared Tauri host-side structure helpers.
//!
//! Platform adapter for the shared-structures slice: host plumbing that more
//! than one slice's Tauri integration needs but that belongs to none of them.
//!
//! Today that is [`sandboxed_webview`] — opening an arbitrary external
//! (non-Tauri) page in a separate, *less-privileged* top-level webview. The
//! window logic is generalised from the browser-sniffer host adapter
//! (`browser-sniffer-tauri-rust`): it injects the shared browser-top-bar
//! bootstrap (from `shared-structures-tauri`, the same bar the sniffer uses) so
//! the user gets Back / Reload / URL chrome and a way to dismiss the window, and
//! hard-codes nothing slice-specific — so the apps launch flow, the sniffer, or
//! any future "open this untrusted URL" path can reuse it. The webview's reduced
//! surface is enforced by a matching capability JSON in the composing app (see
//! `capabilities/sandboxed-webview.json` in `wildflower-tauri`), not by this
//! crate.

mod bootstrap;
pub mod sandboxed_webview;

pub use sandboxed_webview::{
    attach_close_listener, close, mark_closed, open_or_navigate, resolve_http_url,
    CLOSE_SANDBOXED_WEBVIEW_TAG, SANDBOXED_WEBVIEW_LABEL,
};
