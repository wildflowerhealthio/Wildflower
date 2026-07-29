//! [`SnifferWebviewHandle`] — the host seam the `/sniffer` control endpoints
//! drive. The port keeps this crate Tauri-free: the Tauri host implements it
//! over `tauri-plugin-native-webview` (see `browser-sniffer-tauri-rust`), and
//! the route tests implement it as a recording fake. Mirrors the apps slice's
//! `OnDeviceWebviewHandle` seam, but returns `Result` — under HTTP a plugin
//! failure is an answerable 500, not a warn-and-drop.

/// Host seam for the sniffer's native webview. One instance exists per host
/// (the plugin's single `"sniffer"` webview instance), so the operations carry
/// no webview id.
///
/// Every operation is synchronous from the caller's perspective (the plugin
/// calls are quick dispatches); failures are infrastructure-shaped and render
/// as opaque 500s.
pub trait SnifferWebviewHandle: Send + Sync {
    /// Navigate the sniffer webview to `url` (an `http(s)://` URL already
    /// validated by [`resolve_source`](crate::domain::resolve_source)),
    /// building it fresh — sniffer bootstrap injected — if none exists, and
    /// present it. Idempotent-in-place: a call while a webview is up rebinds
    /// and navigates the existing one rather than stacking a second.
    ///
    /// # Errors
    ///
    /// Any plugin failure opening, navigating, or presenting the webview.
    fn open_or_navigate(&self, url: &str) -> anyhow::Result<()>;

    /// Write `name` to the sniffer chrome's subtitle (the per-step status
    /// label). A no-op when no webview is up.
    ///
    /// # Errors
    ///
    /// Any plugin failure patching the window text.
    fn set_status(&self, name: &str) -> anyhow::Result<()>;

    /// (Re-)present the existing webview without navigating — reveals a
    /// hidden-but-alive webview. Idempotent, and a no-op when none exists.
    ///
    /// # Errors
    ///
    /// Any plugin failure showing the webview.
    fn show(&self) -> anyhow::Result<()>;

    /// Tear the webview down and free its resources — the terminal
    /// `SniffingComplete` signal. The host reports the teardown back on the
    /// event stream as a `SnifferDisposed` lifecycle event.
    ///
    /// # Errors
    ///
    /// Any plugin failure disposing the webview.
    fn dispose(&self) -> anyhow::Result<()>;

    /// Forward a tagged bridge envelope (a `PageAction` or
    /// `CancelSnifferRequest`) into the sniffed page, where the injected
    /// sniffer bootstrap demuxes it by `_tag`.
    ///
    /// `envelope_json` is the full `{"_tag": …, …}` object, pre-serialized by
    /// this crate from a typed body — the handle never composes wire shapes.
    ///
    /// # Errors
    ///
    /// Any plugin failure evaluating the forward script. A missing webview is
    /// NOT an error: the collector cancels speculatively during teardown, so
    /// the handle treats "no webview open" as a benign no-op.
    fn forward_to_page(&self, envelope_json: &str) -> anyhow::Result<()>;
}
