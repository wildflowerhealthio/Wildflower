//! Build / reopen / teardown machinery: [`present`] (the three-branch open),
//! `apply_rewire` (in-place reopen), the window lifecycle listeners, and the
//! absolute-timeout backstop. The cross-platform protocols these implement live
//! in docs/Lifecycle and Races Explanation.md.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::webview::{Webview, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, Window, WindowEvent,
};
use url::Url;

use super::chrome::{
    apply_chrome_height, build_chrome_data_url, InitialChromeState, CHROME_HEIGHT_BASE,
    CHROME_NAV_STATE_FN, CHROME_RESET_TEXT_FN, CHROME_SET_URL_FN,
};
use super::cookies::seed_then_navigate;
use super::labels::{chrome_label, content_label, window_label};
use super::state::{install_instance_state, instance_state, lock_state};
use crate::models::{NativeWebviewEvent, OpenRequest};

/// What [`present`] did, so [`super::NativeWebview::open_url`] knows whether the
/// content webview exists yet and thus who seeds the cookies.
pub(super) enum PresentOutcome {
    /// Built fresh or rewired in place — the content webview is live now, so
    /// `open_url` hands any cookies to
    /// [`super::cookies::seed_then_navigate`], which seeds them and navigates to
    /// the target once they commit.
    Presented,
    /// A dispose was in flight, so the request (cookies and all) was deferred into
    /// [`super::state::InstanceState::pending_reopen`]; the `CloseRequested`
    /// replay owns the rebuild AND the cookie seeding.
    Deferred,
}

/// Teardown backstop — see docs/Lifecycle and Races Explanation.md § "Teardown backstops"
/// (desktop's absolute-lifetime cap; re-armed per `open_url` via
/// [`arm_absolute_timeout`], superseded via
/// [`super::state::InstanceState::timeout_generation`]).
const ABSOLUTE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The transient `about:blank` a cookie-seeding open builds at before
/// navigating to the real target (see [`present`]).
pub(super) fn blank_url() -> crate::Result<Url> {
    Url::parse("about:blank").map_err(|error| crate::Error::Internal(error.to_string()))
}

/// Arm (or re-arm) instance `id`'s [`ABSOLUTE_TIMEOUT`] backstop — see
/// docs/Lifecycle and Races Explanation.md § "Teardown backstops". Bumps that
/// instance's `timeout_generation` (superseding any prior timer), wakes the
/// prior generation's parked thread so it exits immediately, and spawns a parked
/// thread (no async runtime dependency; ≤1 live per instance across rapid
/// reopens, since each re-arm releases the last) that disposes on fire iff its
/// captured generation is still current. On fire it mirrors a host `dispose()`
/// (set `disposing`, `window.close()`). The thread holds an
/// `Arc<InstanceState>` so its condvar stays valid even though the instance map
/// is looked up by id elsewhere.
fn arm_absolute_timeout<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(instance) = instance_state(app, id) else {
        return;
    };
    let generation = instance.timeout_generation.fetch_add(1, Ordering::SeqCst) + 1;
    // Release any prior generation's parked thread now that it's superseded.
    instance.timeout_changed.notify_all();
    let app = app.clone();
    let id = id.to_owned();
    std::thread::spawn(move || {
        // Park until ABSOLUTE_TIMEOUT elapses OR this generation is superseded
        // (a re-arm or teardown bumps the generation and notifies). A poisoned
        // condvar mutex just drops the backstop — teardown handles itself.
        let Ok(guard) = instance.timeout_wait.lock() else {
            return;
        };
        let Ok((_guard, wait)) =
            instance
                .timeout_changed
                .wait_timeout_while(guard, ABSOLUTE_TIMEOUT, |()| {
                    instance.timeout_generation.load(Ordering::SeqCst) == generation
                })
        else {
            return;
        };
        // Superseded before the timeout → this generation is stale, exit.
        if !wait.timed_out() {
            return;
        }
        // Release the condvar guard (which borrows `instance`) before handing a
        // fresh `Arc` clone to the main-thread closure.
        drop(_guard);
        let handle = app.clone();
        let instance = instance.clone();
        // Window ops are main-thread on macOS. A failed marshal (app shutting
        // down) just drops the backstop — teardown is happening anyway.
        let _ = app.run_on_main_thread(move || {
            // Stale (a reopen/teardown advanced the generation between the wait
            // returning and this marshal) → no-op.
            if instance.timeout_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(window) = handle.get_window(&window_label(&id)) else {
                return;
            };
            instance.disposing.store(true, Ordering::SeqCst);
            let _ = window.close();
        });
    });
}

/// Build or re-target instance `id`'s native webview. Three branches:
/// - **Disposing in flight**: defer into
///   [`super::state::InstanceState::pending_reopen`] for the `CloseRequested`
///   handler to replay — see docs/Lifecycle and Races Explanation.md
///   § "The dispose→open \"switch-demo\" race".
/// - **Already open**: replay onto the existing webviews via `apply_rewire` —
///   see docs/Lifecycle and Races Explanation.md § "Re-open rewire".
/// - **Fresh build**: construct the parent window, chrome + content child
///   webviews, and install the resize / close / destroy listeners.
///
/// `target_url` is what the caller asked to open (chrome display, OS title,
/// deferred replay); `build_url` is what the fresh build / rewire actually
/// navigates to — identical except on a cookie-seeding open, where the build
/// parks at `about:blank` and [`super::cookies::seed_then_navigate`] navigates to
/// the target once the cookie writes commit.
///
/// The returned [`PresentOutcome`] tells the caller whether the content webview
/// is live now (`Presented` — `open_url` seeds the cookies) or the request was
/// deferred (`Deferred` — the `CloseRequested` replay seeds them instead).
pub(super) fn present<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    payload: OpenRequest,
    target_url: Url,
    build_url: Url,
) -> crate::Result<PresentOutcome> {
    // Dispose in flight (for THIS instance): defer the replay (last-write-wins on
    // a rapid double-`open`). See [`super::state::InstanceState`]. The stored
    // payload keeps its `cookies`: the `CloseRequested` replay seeds them onto the
    // reused content webview (off-main) before navigating to the target, so a
    // dispose→open carrying auth cookies still lands them. This thread must NOT
    // seed on the deferred branch — the instance's current content webview is
    // doomed (about to close), so seeding there would race the teardown and drop
    // the cookies. `open_url` keys off the `Deferred` outcome to skip its seed.
    if let Some(instance) = instance_state(app, id) {
        if instance.disposing.load(Ordering::SeqCst) {
            *lock_state(&instance.pending_reopen, "pending-reopen")? = Some((payload, target_url));
            return Ok(PresentOutcome::Deferred);
        }
    }

    // Already open: rewire this instance in place rather than rebuild.
    if let Some(content) = app.get_webview(&content_label(id)) {
        apply_rewire(app, id, &content, &payload, target_url, build_url)?;
        return Ok(PresentOutcome::Presented);
    }

    let init_script = payload.init_script;
    let channel = payload.native_webview_event_channel;
    let initial_url = target_url.as_str().to_owned();

    // OS-level title (taskbar / title bar) is the caller's initial title, else
    // the content URL — never a hard-coded app name.
    let window_title = payload
        .initial_title
        .as_ref()
        .unwrap_or(&initial_url)
        .clone();
    // Built hidden; presented only by an explicit `show()` (see
    // [`super::NativeWebview::open_url`]).
    let window = WindowBuilder::new(app, window_label(id))
        .title(window_title)
        .inner_size(900.0, 700.0)
        .resizable(true)
        .visible(false)
        .build()?;

    let window_size = window.inner_size()?;
    let scale = window.scale_factor()?;
    let logical_width = window_size.width as f64 / scale;
    let logical_height = window_size.height as f64 / scale;

    // Must precede `add_child` so the chrome's first height report (on
    // DOMContentLoaded) and the resize listener find the instance state present.
    install_instance_state(app, id, channel);

    // Chrome webview. The initial state is baked into the `data:` HTML (vs a
    // post-open patch) so the bar is correct on first paint — see the Lifecycle
    // & Races doc § "Chrome URL-fallback". The chrome bar's button clicks +
    // height reports arrive as `fetch`es of the action scheme, dispatched by the
    // handler `super::chrome::register_chrome_action_scheme` installs on the
    // plugin builder — no navigation, so no WebKit policy-`ignore` backtrace, and
    // no `__TAURI__` grant needed on this `data:` origin.
    let chrome_url = build_chrome_data_url(&InitialChromeState {
        url: &initial_url,
        title: payload.initial_title.as_deref(),
        subtitle: payload.initial_subtitle.as_deref(),
        message: payload.initial_message.as_deref(),
    })?;
    let chrome_builder = WebviewBuilder::new(chrome_label(id), WebviewUrl::External(chrome_url));
    window.add_child(
        chrome_builder,
        LogicalPosition::<f64>::new(0.0, 0.0),
        LogicalSize::<f64>::new(logical_width, CHROME_HEIGHT_BASE),
    )?;

    // Content webview: built at `build_url` — the external target, except on a
    // cookie-seeding open, where it parks at `about:blank` until the caller
    // thread's queued cookie writes commit (see [`super::NativeWebview::open_url`]).
    let mut content_builder =
        WebviewBuilder::new(content_label(id), WebviewUrl::External(build_url));
    if let Some(script) = init_script {
        content_builder = content_builder.initialization_script(script);
    }
    // Sync the chrome URL fallback (see docs/Lifecycle and Races Explanation.md § "Chrome
    // URL-fallback") + back/forward state on each page load. `Started` (not
    // `Finished`) so it lands as the navigation commits. See
    // [`super::state::InstanceState`].
    let app_for_loads = app.clone();
    let id_for_loads = id.to_owned();
    content_builder = content_builder.on_page_load(move |_webview, payload| {
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            return;
        }
        // A cookie-seeding open transits `about:blank` before the real target;
        // that transient load must neither flash in the chrome URL bar nor
        // count as a history entry for the Back-button approximation.
        if payload.url().as_str() == "about:blank" {
            return;
        }
        // URL-fallback sync, kept independent of the nav-button bookkeeping below
        // so it still fires if the instance state is somehow absent.
        if let Some(chrome) = app_for_loads.get_webview(&chrome_label(&id_for_loads)) {
            if let Ok(arg) = serde_json::to_string(payload.url().as_str()) {
                let _ = chrome.eval(format!("{CHROME_SET_URL_FN}({arg})"));
            }
        }
        let Some(instance) = instance_state(&app_for_loads, &id_for_loads) else {
            return;
        };
        let new_count = {
            // Best-effort in a page-load callback: skip the nav-state update on
            // a poisoned lock rather than panicking.
            let Ok(mut count) = instance.nav_load_count.lock() else {
                return;
            };
            *count = count.saturating_add(1);
            *count
        };
        let can_back = new_count > 1;
        let can_forward = instance.nav_can_forward.load(Ordering::SeqCst);
        if let Some(chrome) = app_for_loads.get_webview(&chrome_label(&id_for_loads)) {
            let _ = chrome.eval(format!(
                "{CHROME_NAV_STATE_FN}({{canBack:{can_back},canForward:{can_forward}}})"
            ));
        }
    });
    window.add_child(
        content_builder,
        LogicalPosition::<f64>::new(0.0, CHROME_HEIGHT_BASE),
        LogicalSize::<f64>::new(
            logical_width,
            (logical_height - CHROME_HEIGHT_BASE).max(0.0),
        ),
    )?;

    install_window_listeners(app, id, &window);
    arm_absolute_timeout(app, id);

    Ok(PresentOutcome::Presented)
}

/// Replay an `open` request onto instance `id`'s existing chrome + content
/// webviews (rebind channel, re-eval init script, re-apply initial chrome,
/// navigate) — see docs/Lifecycle and Races Explanation.md § "Re-open rewire". The init
/// script lands via `eval` (not document-start: Tauri has no API to swap that
/// hook post-build); harmless here since a given instance always reopens with a
/// stable script (a distinct purpose uses a distinct instance id).
///
/// `target` feeds the chrome display; `navigate_to` is what actually loads —
/// identical except on a cookie-seeding open (see [`present`]'s doc), where this
/// parks the content at `about:blank` and
/// [`super::cookies::seed_then_navigate`] navigates to the target after the
/// cookie writes commit. The `CloseRequested` replay passes the target for both
/// when the deferred payload carries no cookies.
fn apply_rewire<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    content: &Webview<R>,
    payload: &OpenRequest,
    target: Url,
    navigate_to: Url,
) -> crate::Result<()> {
    if let Some(instance) = instance_state(app, id) {
        *lock_state(&instance.current_channel, "current-channel")? =
            payload.native_webview_event_channel.clone();
        // Same content webview → keep `nav_load_count` (Back stays enabled); only
        // clear `nav_can_forward` (fresh nav truncates the forward stack). See
        // [`super::state::InstanceState`].
        instance.nav_can_forward.store(false, Ordering::SeqCst);
    }
    if let Some(script) = &payload.init_script {
        let _ = content.eval(script);
    }
    if let Some(chrome) = app.get_webview(&chrome_label(id)) {
        // A rewire is logically a fresh open: reset the chrome's URL-fallback
        // claims + slots and seed the new URL (don't merge onto prior claims).
        let reset = InitialChromeState {
            url: target.as_str(),
            title: payload.initial_title.as_deref(),
            subtitle: payload.initial_subtitle.as_deref(),
            message: payload.initial_message.as_deref(),
        };
        if let Ok(json) = serde_json::to_string(&reset) {
            let _ = chrome.eval(format!("{CHROME_RESET_TEXT_FN}({json})"));
        }
    }
    // Blank the previous page before the navigation: a reused content webview
    // otherwise keeps showing the prior app until the new target's first
    // paint. Queued ahead of `navigate` on the same FIFO loop, so the clear
    // always lands first.
    let _ = content.eval("document.documentElement.innerHTML = ''");
    let _ = content.navigate(navigate_to);
    // A reopen starts a new task clock — re-arm the backstop.
    arm_absolute_timeout(app, id);
    Ok(())
}

/// Instance `id`'s window lifecycle hooks:
///
/// - **Resized**: re-lay chrome (top) + content (rest) at the stored
///   [`super::state::InstanceState::chrome_height`] so they always tile the
///   parent exactly.
/// - **CloseRequested**: titlebar X (no `disposing`) → user dismissal: hide +
///   emit `Hidden` (docs/Lifecycle and Races Explanation.md § "User dismissal hides; only
///   `dispose` tears down"). `disposing` set → resolve the dispose→open race via
///   [`super::state::InstanceState::pending_reopen`] (§ "The dispose→open
///   \"switch-demo\" race").
/// - **Destroyed**: emit `Disposed` and clear
///   [`super::state::InstanceState::disposing`]. Reached by host `dispose()`, the
///   [`ABSOLUTE_TIMEOUT`] backstop, or app-exit window teardown
///   (§ "Teardown backstops").
///
/// `on_window_event` takes a `Fn(&WindowEvent) + Send + 'static`, so captures
/// are clones; the channel is read from
/// [`super::state::InstanceState::current_channel`] at fire time (not captured)
/// so rewires take effect. The `id` is captured so every handler resolves *this*
/// instance's state.
fn install_window_listeners<R: Runtime>(app: &AppHandle<R>, id: &str, window: &Window<R>) {
    let app_window = app.clone();
    let window_clone = window.clone();
    let id = id.to_owned();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_size) => {
            let height = instance_state(&app_window, &id)
                .and_then(|instance| instance.chrome_height.lock().ok().map(|height| *height))
                .unwrap_or(CHROME_HEIGHT_BASE);
            apply_chrome_height(&app_window, &id, &window_clone, height);
        }
        WindowEvent::CloseRequested { api, .. } => {
            let Some(instance) = instance_state(&app_window, &id) else {
                return;
            };
            // No `disposing` → user dismissal (titlebar X): hide + emit `Hidden`.
            // (App teardown destroys windows on a path that bypasses `prevent_close`.)
            if !instance.disposing.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = window_clone.hide();
                if let Ok(channel) = instance.current_channel.lock() {
                    let _ = channel.send(NativeWebviewEvent::Hidden);
                }
                return;
            }
            // `dispose()` in flight: take any deferred replay (see
            // [`super::state::InstanceState`]). `Some` → cancel + replay; `None` →
            // let the dispose land.
            let pending = match instance.pending_reopen.lock() {
                Ok(mut guard) => guard.take(),
                // Poisoned lock: can't consult the slot → let the dispose proceed.
                Err(_) => return,
            };
            let Some((mut payload, target)) = pending else {
                return;
            };
            api.prevent_close();
            instance.disposing.store(false, Ordering::SeqCst);
            let Some(content) = app_window.get_webview(&content_label(&id)) else {
                return;
            };
            // The deferred open carried its cookies — `open_url` skipped its own
            // seed on the `Deferred` outcome because the instance was mid-dispose
            // (see [`present`]). Seed them now, onto the reused content webview.
            let cookies = std::mem::take(&mut payload.cookies);
            if cookies.is_empty() {
                let _ = apply_rewire(&app_window, &id, &content, &payload, target.clone(), target);
            } else {
                // Mirror `open_url`'s fresh-build cookie order: rewire the reused
                // webview to `about:blank`, then seed and navigate to the target
                // once the writes commit. `apply_rewire` queues its blank navigate
                // before `seed_then_navigate` schedules anything, so the target
                // can never paint ahead of its cookies. The seed never blocks this
                // main-thread tao callback on WebKit — see
                // [`super::cookies::seed_then_navigate`].
                let blank = blank_url().unwrap_or_else(|_| target.clone());
                let _ = apply_rewire(&app_window, &id, &content, &payload, target.clone(), blank);
                let _ = seed_then_navigate(&app_window, &id, cookies, target);
            }
        }
        WindowEvent::Destroyed => {
            let Some(instance) = instance_state(&app_window, &id) else {
                return;
            };
            // Notify the current caller's channel
            // ([`super::state::InstanceState::current_channel`]) that the webview
            // is gone.
            if let Ok(channel) = instance.current_channel.lock() {
                let _ = channel.send(NativeWebviewEvent::Disposed);
            }
            instance.disposing.store(false, Ordering::SeqCst);
            // Advance the generation + wake so the backstop thread for the
            // now-destroyed webview exits immediately instead of parking out
            // the full ABSOLUTE_TIMEOUT (its fire would no-op on the missing
            // window anyway). See [`arm_absolute_timeout`].
            instance.timeout_generation.fetch_add(1, Ordering::SeqCst);
            instance.timeout_changed.notify_all();
            // Drop any payload that raced a close-that-actually-landed (a
            // tiny lossy edge only for off-main-thread close+open callers;
            // the listener-thread case runs `present()` before the close).
            if let Ok(mut pending) = instance.pending_reopen.lock() {
                *pending = None;
            };
        }
        _ => {}
    });
}
