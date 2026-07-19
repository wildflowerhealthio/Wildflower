//! Desktop backend. Mirrors the iOS/Android layout via Tauri's
//! multi-webview-per-window API (`Window::add_child`, `unstable` feature): a
//! chrome bar (title / subtitle / message + back / forward / refresh) anchored
//! at the top and the external content webview below, sharing one parent
//! `Window`. Unlike mobile, desktop is **multi-instance**: one such window (plus
//! its per-id state in [`state::PluginState`]) exists per caller-named instance
//! id, so e.g. a background sniffer scrape and a launched app run concurrently
//! without colliding — every function here is keyed by `id`. The cross-platform
//! lifecycle/race protocols this implements live in
//! [docs/Lifecycle and Races Explanation.md](../docs/Lifecycle%20and%20Races%20Explanation.md); the
//! higher-level "what / why" in [docs/Explanation.md](../docs/Explanation.md).
//!
//! ## Layout
//!
//! - [`labels`] — per-instance window/webview label construction + parsing.
//! - [`state`] — the per-id [`state::InstanceState`] registry.
//! - [`cookies`] — pre-navigation cookie seeding.
//! - [`chrome`] — the chrome bar, its build, the `x-nv-action` action scheme.
//! - [`lifecycle`] — `present` (build/reopen/teardown) + window listeners.
//! - this module — plugin `init` + the [`NativeWebview`] handle (public API).
//!
//! ## Chrome ↔ Rust IPC
//!
//! The chrome webview loads its DOM from a base64 `data:text/html` URL (see
//! [`chrome`]). Communication needs no `__TAURI__` event bus access on either
//! side:
//!
//! - **Chrome → Rust**: button clicks + height reports `fetch` a custom-scheme
//!   URL; the URI-scheme handler [`chrome::register_chrome_action_scheme`]
//!   installs dispatches the matching `eval` onto the content webview (or resizes
//!   the chrome). A subresource fetch never enters WebKit's navigation-policy
//!   path, so — unlike the earlier cancelled-nav trick — it emits no
//!   policy-`ignore` backtrace; and being a webview resource loader rather than
//!   an IPC command, it needs no capability grant. The handler guards on the
//!   requesting webview label so only a chrome webview can drive these actions
//!   (and the label names the instance).
//! - **Rust → Chrome**: `webview.eval(...)` — Rust-initiated, so it bypasses
//!   capability checks and the chrome's `data:` origin needs no capability entry.
//!
//! Caveat vs. mobile: both webviews are Tauri webviews here, so the content one
//! still has `window.__TAURI__`; the host app's capability JSON scopes it to
//! event-bus listen plus the gated `native_webview_data_plane_emit` command (no
//! bus `emit`, no log) — see `capabilities/native-webview-window.json`.

use std::sync::atomic::Ordering;

use serde::de::DeserializeOwned;
use tauri::plugin::PluginApi;
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use crate::models::{EvaluateJsRequest, NativeWebviewEvent, OpenRequest, PatchWindowTextRequest};

mod chrome;
mod cookies;
mod labels;
mod lifecycle;
mod state;

/// Re-exported for `lib.rs`'s plugin builder — registers the chrome action
/// scheme (see [`chrome::register_chrome_action_scheme`]).
pub(crate) use chrome::register_chrome_action_scheme;

use chrome::WINDOW_TEXT_FN;
use cookies::seed_cookies;
use labels::{chrome_label, content_label, window_label};
use lifecycle::{blank_url, present, PresentOutcome};
use state::{instance_state, PluginState};

/// Build the desktop backend.
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeWebview<R>> {
    app.manage(PluginState::new());
    Ok(NativeWebview(app.clone()))
}

/// Desktop handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeWebview<R> {
    /// Build (if absent) and navigate instance `id`'s native webview to `url`
    /// without presenting it — see docs/Lifecycle and Races Explanation.md § "Visibility,
    /// liveness, and existence are independent". Window creation is marshalled
    /// onto the main thread (required on macOS); the result returns via a
    /// `sync_channel`.
    ///
    /// No deadlock: `run_on_main_thread` is synchronous when *called from* the
    /// main thread (`send_user_message` runs `handle_user_message` inline on a
    /// thread match), so a main-thread caller's `tx.send` has already fired by
    /// `rx.recv()`. Off-main-thread callers block on the main thread draining the
    /// queue — safe, no self-wait.
    ///
    /// A cookie-carrying request (see [`OpenRequest`]'s `cookies`) MUST be sent
    /// from OFF the main thread: the webview builds at `about:blank`, then this
    /// caller thread queues the cookie writes + the real-target navigation onto the
    /// main loop (FIFO). See [`cookies::seed_cookies`] for why the main thread
    /// deadlocks. Exception: when a dispose is in flight `present` defers the whole
    /// request (cookies and all) into `pending_reopen` and returns
    /// [`PresentOutcome::Deferred`], and this thread seeds nothing — the
    /// `CloseRequested` replay ([`lifecycle`]) seeds the deferred cookies off-main
    /// after it reuses the content webview, so a dispose→open on the `launch`
    /// instance keeps its auth seeding.
    pub fn open_url(&self, id: &str, payload: OpenRequest) -> crate::Result<()> {
        // Parse once (http(s)-only — see [`crate::url_scheme`]) and thread the
        // parsed `Url` to `present` so the build path doesn't re-parse.
        let target = crate::url_scheme::parse_http_url(&payload.url)?;
        // Keep a copy for the caller-thread seed on the build/rewire path. The
        // payload keeps its OWN `cookies` so the deferred branch carries them into
        // `pending_reopen` for the replay to seed (see the method doc).
        let cookies = payload.cookies.clone();
        let build_url = if cookies.is_empty() {
            target.clone()
        } else {
            blank_url()?
        };
        let app = self.0.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<crate::Result<PresentOutcome>>(1);
        let present_target = target.clone();
        let present_id = id.to_owned();
        self.0.run_on_main_thread(move || {
            // Best-effort: rx is dropped only when the caller already exited.
            let _ = tx.send(present(
                &app,
                &present_id,
                payload,
                present_target,
                build_url,
            ));
        })?;
        let outcome = rx
            .recv()
            .map_err(|error| crate::Error::Internal(error.to_string()))??;
        // Seed from this thread ONLY when `present` built or rewired now — the
        // content webview is live. On the deferred branch (`present` saw a dispose
        // in flight) the instance's content webview is doomed, so seeding here
        // would race the teardown and lose the cookies; the `CloseRequested` replay
        // seeds the deferred payload's cookies instead.
        if !cookies.is_empty() && matches!(outcome, PresentOutcome::Presented) {
            let content = self.0.get_webview(&content_label(id)).ok_or_else(|| {
                crate::Error::Internal(
                    "native-webview content webview missing after a cookie-seeding open".to_owned(),
                )
            })?;
            seed_cookies(&content, &cookies)?;
            content.navigate(target)?;
        }
        Ok(())
    }

    /// Cookie **names** currently visible to instance `id`'s content webview for
    /// `url` — a read-back for verifying the pre-navigation cookie seeding (see
    /// [`OpenRequest`]'s `cookies`). Names only, never values: the point is
    /// observability ("did `wf_auth` land?"), not exfiltrating the jar.
    /// `Ok(None)` when no content webview is open. Desktop-only (mobile has no
    /// equivalent surface; wry's Android cookie read is a stub anyway).
    pub fn content_cookie_names_for_url(
        &self,
        id: &str,
        url: Url,
    ) -> crate::Result<Option<Vec<String>>> {
        let Some(content) = self.0.get_webview(&content_label(id)) else {
            return Ok(None);
        };
        let cookies = content.cookies_for_url(url)?;
        Ok(Some(
            cookies
                .iter()
                .map(|cookie| cookie.name().to_owned())
                .collect(),
        ))
    }

    /// Evaluate JS in instance `id`'s content webview. Returns an error if no
    /// native webview is open (matches the mobile contract — `evaluate_js` is
    /// content-bound, so there's no graceful fallback).
    pub fn evaluate_js(&self, id: &str, payload: EvaluateJsRequest) -> crate::Result<()> {
        let content = self
            .0
            .get_webview(&content_label(id))
            .ok_or_else(|| crate::Error::Internal("no native-webview open".to_owned()))?;
        content.eval(&payload.script)?;
        Ok(())
    }

    /// Push title / subtitle / message into instance `id`'s chrome by `eval`-ing
    /// the init-script-defined `__nativeWebviewPatchWindowText` global with a JSON
    /// payload of only the fields the caller wants to change. The JS side
    /// applies non-`null` fields and leaves the rest untouched — matching
    /// the iOS / Android `patchWindowText` semantics.
    ///
    /// No-op if no native webview is open. Returns `Ok` either way so callers can
    /// fire speculatively across the native webview lifecycle (mirrors mobile
    /// `{set: false}` on a closed native webview).
    pub fn patch_window_text(
        &self,
        id: &str,
        payload: PatchWindowTextRequest,
    ) -> crate::Result<()> {
        let Some(chrome) = self.0.get_webview(&chrome_label(id)) else {
            return Ok(());
        };
        // The wire camelCase keys match what `__nativeWebviewPatchWindowText` reads.
        let json = serde_json::to_string(&payload)
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        chrome.eval(format!("{WINDOW_TEXT_FN}({json})"))?;
        Ok(())
    }

    /// Present instance `id`'s native webview window (built hidden by
    /// [`open_url`](Self::open_url)) — see docs/Lifecycle and Races Explanation.md
    /// § "Visibility, liveness, and existence are independent". Reveals
    /// immediately; a `show()` before the content's first paint may briefly flash
    /// the window background on macOS dark mode — accepted. Idempotent — no-op if
    /// no window exists.
    pub fn show(&self, id: &str) -> crate::Result<()> {
        if let Some(window) = self.0.get_window(&window_label(id)) {
            window.show()?;
            let _ = window.set_focus();
        }
        Ok(())
    }

    /// Hide instance `id`'s window but keep it (and its child webviews) alive and
    /// running — see docs/Lifecycle and Races Explanation.md § "User dismissal hides; only
    /// `dispose` tears down". Emits [`NativeWebviewEvent::Hidden`]. Idempotent —
    /// no-op if no window exists.
    ///
    /// Site-specific: `window.hide()` fires no `CloseRequested`/`Destroyed`, so
    /// nothing is torn down (and `Hidden` must be emitted directly here — there
    /// is no `Destroyed` for the window listener to translate).
    pub fn hide(&self, id: &str) -> crate::Result<()> {
        let Some(window) = self.0.get_window(&window_label(id)) else {
            return Ok(());
        };
        window.hide()?;
        if let Some(instance) = instance_state(&self.0, id) {
            if let Ok(channel) = instance.current_channel.lock() {
                let _ = channel.send(NativeWebviewEvent::Hidden);
            }
        }
        Ok(())
    }

    /// Dispose instance `id`'s native webview window — tear it down and free its
    /// resources; the `Destroyed` handler emits [`NativeWebviewEvent::Disposed`].
    /// Flips the instance's `disposing` flag before closing so a racing same-tick
    /// `open_url()` defers — see [`state::InstanceState`] and
    /// docs/Lifecycle and Races Explanation.md § "The dispose→open \"switch-demo\" race".
    /// Idempotent — no-op if no window.
    pub fn dispose(&self, id: &str) -> crate::Result<()> {
        let Some(window) = self.0.get_window(&window_label(id)) else {
            return Ok(());
        };
        if let Some(instance) = instance_state(&self.0, id) {
            instance.disposing.store(true, Ordering::SeqCst);
        }
        window.close()?;
        Ok(())
    }
}
