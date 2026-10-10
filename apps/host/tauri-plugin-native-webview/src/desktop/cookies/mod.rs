//! Pre-navigation cookie seeding.
//!
//! This module is the **seam**: it owns the contract and picks the
//! implementation. It contains no cookie logic of its own, and the `cfg` below
//! is the only platform branch in the seeding path — [`wkwebview`] and [`wry`]
//! each expose exactly one item, `seed_then_navigate`, with the same signature.
//! The one piece of shared behaviour that lives here rather than in either
//! implementation is [`superseded`], so both agree on when a scheduled seed has
//! lost its claim on the webview.
//!
//! ## The contract both implementations satisfy
//!
//! ```ignore
//! pub(super) fn seed_then_navigate<R: Runtime>(
//!     app: &AppHandle<R>,
//!     id: &str,
//!     cookies: Vec<CookieSpec>,
//!     target: Url,
//!     scheduled_at: u64,
//! ) -> crate::Result<()>
//! ```
//!
//! Write `cookies` into instance `id`'s cookie jar, then navigate its content
//! webview to `target` once they have committed — unless a newer open has
//! superseded the one identified by `scheduled_at`.
//!
//! - **Asynchronous.** It returns as soon as the work is scheduled, so a
//!   successful return does *not* mean the cookies are in the jar. Callers park
//!   the content webview at `about:blank` first (see
//!   [`super::lifecycle::present`]) precisely so the target's first request
//!   cannot outrun the seed.
//! - **Callable from either thread.** Each implementation marshals as it needs
//!   to. This is what lets the `CloseRequested` deferred replay — a main-thread
//!   tao callback — call it directly instead of spawning a thread and hoping.
//! - **Scoped to one open.** `scheduled_at` is the
//!   [`super::state::InstanceState::open_generation`] the calling open claimed.
//!   A later open of the same instance supersedes this seed's *navigation*
//!   (via [`superseded`]) — never its writes.
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

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Runtime};

use super::state::instance_state;

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

/// Has a newer open taken instance `id`'s content webview since a seed was
/// scheduled at generation `scheduled_at`?
///
/// Both implementations resolve that webview by label at completion time, and a
/// label outlives the open that scheduled the seed — so this is what stops a
/// late completion navigating a webview a newer open has since rewired. See
/// [docs/Lifecycle and Races Explanation.md](../../../docs/Lifecycle%20and%20Races%20Explanation.md)
/// § "A seed's navigation belongs to the open that scheduled it".
fn superseded<R: Runtime>(app: &AppHandle<R>, id: &str, scheduled_at: u64) -> bool {
    let current =
        instance_state(app, id).map(|instance| instance.open_generation.load(Ordering::SeqCst));
    is_superseded(current, scheduled_at)
}

/// The decision [`superseded`] wraps, split out from the `AppHandle` lookup so
/// it is testable on every platform (the implementations it guards are each
/// behind a `cfg`, and one of them never builds in CI).
///
/// Two of the three cases are "yes" for the same reason — the seed cannot show
/// that its open is the current one:
///
/// - `current` is `None`: the instance has no registered state at all, so there
///   is no live open to belong to.
/// - `scheduled_at` is 0: the open never claimed a generation. A claim
///   increments before returning (see
///   [`super::lifecycle::claim_open_generation`]), so 0 is not a value any open
///   can hold, and must not be allowed to match a not-yet-claimed counter.
fn is_superseded(current: Option<u64>, scheduled_at: u64) -> bool {
    scheduled_at == 0 || current != Some(scheduled_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The seed's own open is still the current one — navigate.
    #[test]
    fn is_superseded_says_no_for_the_scheduling_open() {
        assert!(!is_superseded(Some(7), 7));
    }

    /// Any *other* generation means a later open has rewired the content
    /// webview, so the seed's target is stale. Compared for inequality, not
    /// `>`: the token is monotonic, but a seed that somehow outlives a counter
    /// it can no longer match must bail either way.
    #[test]
    fn is_superseded_says_yes_once_a_newer_open_lands() {
        assert!(is_superseded(Some(8), 7));
        assert!(is_superseded(Some(0), 7));
    }

    /// No instance state → nothing to navigate on behalf of.
    #[test]
    fn is_superseded_says_yes_when_the_instance_is_gone() {
        assert!(is_superseded(None, 7));
    }

    /// The unclaimed sentinel never matches — including against a counter that
    /// is itself still at 0, which is the one comparison a plain inequality
    /// would get wrong.
    #[test]
    fn is_superseded_says_yes_for_an_open_that_claimed_nothing() {
        assert!(is_superseded(Some(0), 0));
        assert!(is_superseded(None, 0));
    }
}
