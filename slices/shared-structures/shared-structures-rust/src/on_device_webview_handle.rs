//! `OnDeviceWebviewHandle` — a host seam for opening a URL in a native webview
//! popup on the user's own device.
//!
//! The platform-pure launch handler resolves a launch target the same way for
//! every host, then decides what to do with it from the request's provenance: a
//! *forwarded* (relayed/remote) caller gets a `302` to follow, while a *loopback*
//! (local) caller is handed to this seam — the host opens the URL in a separate,
//! less-privileged native webview popup and the handler `204`s so the SPA stays
//! mounted. A host with no native popup (web/standalone) supplies a no-op
//! handle; in practice such hosts only ever see forwarded callers, so the seam
//! isn't exercised there.
//!
//! It lives in `shared-structures-rust` (not the apps slice) because it's a
//! generic on-device capability, and keeps the apps slice from depending on the
//! Tauri host directly.

/// Host seam for opening a launch URL in an on-device native webview popup.
///
/// Fire-and-forget: the launch handler `204`s immediately and the host logs any
/// failure (it can't surface one onto the already-sent response).
pub trait OnDeviceWebviewHandle: Send + Sync {
    /// Open `url` in a native popup whose chrome shows `title` (the launched
    /// app's name).
    fn open(&self, title: String, url: String);
}
