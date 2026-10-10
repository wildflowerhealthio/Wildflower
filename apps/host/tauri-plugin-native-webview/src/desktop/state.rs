//! Per-instance state registry. The desktop backend is multi-instance, so all
//! the coordination + chrome/nav state that a single-window design would keep in
//! app-global singletons (or type-keyed `window.manage` cells — which are
//! app-global too; see [`install_instance_state`]) lives here in a per-id map.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use super::chrome::CHROME_HEIGHT_BASE;
use crate::models::{NativeWebviewEvent, OpenRequest};

/// App-managed registry of every live native-webview instance, keyed by the
/// caller-named instance id (see [`super::labels::window_label`]). Each instance
/// is fully isolated so, e.g., a background sniffer scrape and a launched app can
/// run concurrently in separate windows without trampling each other's chrome
/// height, nav history, event channel, or dispose→open race state — the reason
/// this replaced the earlier single-shared-window model.
pub(super) struct PluginState {
    /// Instance state by id. An entry is created (or reset) on a fresh
    /// [`super::lifecycle::present`] build and left in place across
    /// dispose/reopen — ids are a small fixed set (`sniffer`, `launch`), so the
    /// map never grows unbounded and keeping entries preserves the backstop
    /// thread's condvar identity.
    instances: Mutex<HashMap<String, Arc<InstanceState>>>,
}

impl PluginState {
    /// An empty registry — one is `app.manage`d at plugin init.
    pub(super) fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
        }
    }
}

/// Per-instance coordination + chrome/nav state. One of these lives per instance
/// id in [`PluginState::instances`].
///
/// Site-specific: `WebviewWindow::close()` only *queues* a `WindowMessage::Close`
/// via the runtime proxy (`runtime-wry/lib.rs::WindowDispatcher::close`) and
/// returns immediately, which is why the same-tick `present()` runs before
/// `CloseRequested` and the [`Self::pending_reopen`] deferral is needed.
pub(super) struct InstanceState {
    /// Chrome bar's current logical-px height. Read by the resize listener (so a
    /// window resize keeps the right vertical split), written by the chrome →
    /// Rust height-report fetch.
    pub(super) chrome_height: Mutex<f64>,
    /// Last `(logical_w, logical_h, chrome_height)` actually applied to **both**
    /// child webviews, so [`super::chrome::apply_chrome_height`] can
    /// short-circuit a no-op relayout. Recorded only once both children were
    /// present and laid out.
    pub(super) applied_layout: Mutex<Option<(f64, f64, f64)>>,
    /// The [`Channel<NativeWebviewEvent>`] this instance's events fire on;
    /// re-bound by [`super::lifecycle::present`]'s rewire so a second `open`
    /// routes subsequent events (dismissal `Hidden`, teardown `Disposed`) to the
    /// latest caller.
    pub(super) current_channel: Mutex<Channel<NativeWebviewEvent>>,
    /// Content nav-history approximation (Tauri exposes no `can_go_back`):
    /// `load_count` ++ on every content Started load, `canBack` = `> 1`. Reset to
    /// 0 only on a fresh build — a reopen navigating the same content webview
    /// keeps it, so Back stays enabled once ≥2 pages loaded.
    pub(super) nav_load_count: Mutex<u32>,
    /// `true` once the chrome Back button fires (fresh-nav truncates the forward
    /// stack, so a rewire clears it); left sticky otherwise.
    pub(super) nav_can_forward: AtomicBool,
    /// The `disposing` flag: `true` between `dispose()` and the following
    /// `Destroyed`. Read by `present()` to take the deferral branch.
    pub(super) disposing: AtomicBool,
    /// The deferred replay (`present()` request + its already-parsed [`Url`], so
    /// the `CloseRequested` replay doesn't re-parse). The handler `Option::take`s
    /// it: `Some` → cancel the dispose and replay; `None` → dispose proceeds.
    pub(super) pending_reopen: Mutex<Option<(OpenRequest, Url)>>,
    /// Advances on every open that points this instance's content webview at a
    /// new target, so an asynchronous cookie seed can tell whether it still owns
    /// the navigation it scheduled — see docs/Lifecycle and Races Explanation.md
    /// § "A seed's navigation belongs to the open that scheduled it".
    ///
    /// Claimed only on the main thread ([`super::lifecycle::claim_open_generation`]),
    /// and the one field [`install_instance_state`] carries across a fresh
    /// build's reset: restarting it would let a rebuilt instance hand a new open
    /// a value an older in-flight seed is still holding.
    pub(super) open_generation: AtomicU64,
    /// Generation counter for the absolute-timeout backstop (see
    /// [`super::lifecycle`]).
    pub(super) timeout_generation: AtomicU64,
    /// Condvar mutex paired with [`Self::timeout_changed`]. Held only for the
    /// brief predicate re-check inside the backstop thread's timed wait; carries
    /// no data (the generation lives in the atomic).
    pub(super) timeout_wait: Mutex<()>,
    /// Notified whenever [`Self::timeout_generation`] advances (a re-arm or a
    /// teardown) so a parked backstop thread wakes the instant it's superseded
    /// instead of lingering until the absolute timeout — keeps ≤1 thread parked.
    pub(super) timeout_changed: Condvar,
    /// Where this instance's page-initiated downloads are written, from the
    /// latest open's [`crate::models::OpenRequest::download_dir`]; `None`
    /// blocks them.
    ///
    /// A cell rather than a capture because the `on_download` closure is
    /// installed once at build time and cannot be swapped: it reads this at
    /// request time, exactly as the window listeners read
    /// [`Self::current_channel`] at fire time, so a rewire re-points or
    /// re-blocks a live instance. See [`super::lifecycle::apply_rewire`].
    pub(super) download_dir: Mutex<Option<PathBuf>>,
}

impl InstanceState {
    /// A fresh instance's state (nav history at 0, not disposing, no pending
    /// replay), bound to `channel` and to `download_dir`. `open_generation` is
    /// carried in rather than zeroed — see [`Self::open_generation`].
    fn new(
        channel: Channel<NativeWebviewEvent>,
        download_dir: Option<PathBuf>,
        open_generation: u64,
    ) -> Self {
        Self {
            chrome_height: Mutex::new(CHROME_HEIGHT_BASE),
            applied_layout: Mutex::new(None),
            current_channel: Mutex::new(channel),
            nav_load_count: Mutex::new(0),
            nav_can_forward: AtomicBool::new(false),
            disposing: AtomicBool::new(false),
            pending_reopen: Mutex::new(None),
            open_generation: AtomicU64::new(open_generation),
            timeout_generation: AtomicU64::new(0),
            timeout_wait: Mutex::new(()),
            timeout_changed: Condvar::new(),
            download_dir: Mutex::new(download_dir),
        }
    }
}

/// Clone-out the [`InstanceState`] for `id`, or `None` if no such instance is
/// registered. Returns an `Arc` so callers work without holding the map lock.
pub(super) fn instance_state<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Option<Arc<InstanceState>> {
    let state = app.try_state::<PluginState>()?;
    let map = state.instances.lock().ok()?;
    map.get(id).cloned()
}

/// Lock a native-webview-state mutex, mapping a poisoned lock to a surfaced
/// [`crate::Error`] instead of an `unwrap` panic, so the `open` / `present` path
/// fails cleanly rather than taking the process down. (These critical sections
/// are trivial assignments that never panic, so poisoning isn't expected.)
/// Error-channel-less event handlers (resize / close / destroy) instead skip the
/// update on a poisoned lock — see their call sites.
pub(super) fn lock_state<'a, T>(
    mutex: &'a Mutex<T>,
    what: &str,
) -> crate::Result<std::sync::MutexGuard<'a, T>> {
    mutex
        .lock()
        .map_err(|_| crate::Error::Internal(format!("native-webview {what} state lock poisoned")))
}

/// Insert (or reset) instance `id`'s [`InstanceState`] in [`PluginState`],
/// bound to `channel`. Called on every fresh [`super::lifecycle::present`] build
/// before the children are added so the chrome's first height report and the
/// resize listener find the state present.
///
/// Site-specific (not in the cross-platform doc): the earlier single-window
/// design stashed this in type-keyed `window.manage` cells, but `window.manage`
/// writes APP-GLOBAL state (a `Window`'s manager is the shared `AppManager`, not
/// a per-window map), so it can't hold distinct values for concurrent instances.
/// The per-id map here is what makes multiple live instances possible. Entries
/// are kept across dispose/reopen (ids are a small fixed set), so a fresh build
/// overwrites any prior entry for the same id — equivalent to the old reset.
/// [`InstanceState::open_generation`] is the one field carried across that
/// overwrite (see its doc: the token must not restart); `download_dir` is
/// (re)set from the building open's request, and a rewire updates it in place.
pub(super) fn install_instance_state<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    channel: Channel<NativeWebviewEvent>,
    download_dir: Option<PathBuf>,
) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let Ok(mut map) = state.instances.lock() else {
        return;
    };
    let open_generation = map
        .get(id)
        .map_or(0, |prior| prior.open_generation.load(Ordering::SeqCst));
    map.insert(
        id.to_owned(),
        Arc::new(InstanceState::new(channel, download_dir, open_generation)),
    );
}
