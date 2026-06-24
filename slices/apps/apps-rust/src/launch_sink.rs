//! The launch side-effect seam.
//!
//! The platform-pure launch handler resolves the served origin and the
//! redirect target the same way for every host. What it does with that target
//! differs: a browser/standalone host wants a `302` to follow, but the Tauri
//! host wants to open the URL in a native webview popup while leaving the SPA
//! mounted. [`LaunchSink`] is the host seam for that second case — when one is
//! installed, the handler hands it the resolved `(app, url)` instead of
//! returning a redirect.

use crate::domain::AppEntry;

/// Host seam for the launch side-effect. The platform-pure handler resolves
/// the URL, then hands it (with its app) to the host's sink instead of
/// returning a redirect. Fire-and-forget: the handler 204s and the host logs
/// any failure (mirrors the SPA's prior fire-and-forget bridge emit).
pub trait LaunchSink: Send + Sync {
    fn open(&self, app: &AppEntry, url: &str);
}
