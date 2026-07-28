//! Pre-navigation cookie seeding.
//!
//! This module is the **seam**: it owns the contract and picks the
//! implementation. It contains no cookie logic of its own, and the `cfg` below
//! is the only platform branch in the seeding path — [`wkwebview`] and [`wry`]
//! each expose exactly one item, `seed_then_navigate`, with the same signature.
//!
//! ## The contract both implementations satisfy
//!
//! ```ignore
//! pub(super) fn seed_then_navigate<R: Runtime>(
//!     app: &AppHandle<R>,
//!     id: &str,
//!     cookies: Vec<CookieSpec>,
//!     target: Url,
//! ) -> crate::Result<()>
//! ```
//!
//! Write `cookies` into instance `id`'s cookie jar, then navigate its content
//! webview to `target` once they have committed.
//!
//! - **Asynchronous.** It returns as soon as the work is scheduled, so a
//!   successful return does *not* mean the cookies are in the jar. Callers park
//!   the content webview at `about:blank` first (see
//!   [`super::lifecycle::present`]) precisely so the target's first request
//!   cannot outrun the seed.
//! - **Callable from either thread.** Each implementation marshals as it needs
//!   to. This is what lets the `CloseRequested` deferred replay — a main-thread
//!   tao callback — call it directly instead of spawning a thread and hoping.
//! - **Best-effort past the schedule point.** A failure after the call returns
//!   (webview torn down, a cookie Foundation rejects) is logged, not surfaced;
//!   the navigation still happens, because an unauthenticated page beats a
//!   webview stranded at `about:blank`.
//!
//! Its two callers are [`super::NativeWebview::open_url`]'s build/rewire branch
//! and the `CloseRequested` deferred replay in [`super::lifecycle`].
//!
//! ## Why the implementations differ
//!
//! Only in how the write reaches WebKit. [`wry`] uses tauri's
//! `Webview::set_cookie`; [`wkwebview`] cannot, because on macOS that call pumps
//! a nested run loop inside tao's event handler and self-deadlocks the app — see
//! [docs/Lifecycle and Races Explanation.md](../../../docs/Lifecycle%20and%20Races%20Explanation.md)
//! § "Cookie seeding must not pump the main run loop".
//!
//! ## Where iOS is
//!
//! Not here. `target_os = "macos"` is the whole Apple story in this tree:
//! `desktop/` is gated on `#[cfg(desktop)]`, and `tauri-plugin`'s build script
//! defines `desktop` as `not(ios or android)`. So [`wry`] covers Linux and
//! Windows only, and **iOS never reaches this module** — it takes the `mobile`
//! backend into `NativeWebviewPlugin.swift`.
//!
//! That Swift `seedCookies` already has the shape [`wkwebview`] now adopts:
//! build each `HTTPCookie` from a property dictionary (including the same
//! private `HttpOnly` key), fire `setCookie` with a completion handler, and
//! issue the load from a `DispatchGroup.notify` once every completion has
//! fired. It never blocks a thread waiting on WebKit, so the deadlock this
//! module exists to avoid cannot arise there — nothing to port. The objc2
//! dependencies are likewise scoped to `cfg(target_os = "macos")` in
//! `Cargo.toml`, so an iOS build pulls none of them.

#[cfg(target_os = "macos")]
mod wkwebview;
#[cfg(not(target_os = "macos"))]
mod wry;

// Each implementation declares `seed_then_navigate` as `pub(in crate::desktop)`
// rather than `pub(super)`: a re-export cannot widen an item's visibility, and
// `pub(super)` inside an implementation would stop at this module, one level
// short of the callers in `desktop`.
#[cfg(target_os = "macos")]
pub(super) use wkwebview::seed_then_navigate;
#[cfg(not(target_os = "macos"))]
pub(super) use wry::seed_then_navigate;
