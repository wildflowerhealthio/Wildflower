# tauri-plugin-native-webview — Lifecycle & Races (Explanation)

The canonical description of the cross-platform protocols the three backends
(`desktop.rs`, `ios/Sources/NativeWebviewPlugin.swift`,
`android/.../NativeWebviewPlugin.kt`) each implement. The backends are written to
match this document section-for-section; their inline comments point here rather
than re-deriving the rationale per platform. For the higher-level "what / why",
see [Explanation.md](./Explanation.md).

A note on whose state is whose: each backend tracks the live instance (the
webview, its native chrome, its `Channel<NativeWebviewEvent>`) plus a small set
of flags named identically across platforms where practical (`isVisible` /
`is_visible`, `isDisposing` / `disposing`, the URL-fallback claim flags). The
sections below name the concept; the per-platform field names follow it.

Instancing: **every command takes a caller-named instance id on every platform**,
and each instance is fully independent — its own webview(s), native chrome, event
`Channel`, and its own copy of the lifecycle state below. Desktop holds this per-id
in `desktop::PluginState` (one OS window per id); mobile holds it in a per-id map
(`instances[id]`) in each native backend (Swift / Kotlin). The protocols in this
document apply **per instance** — read "the window" / "the webview" as "this
instance's". (Mobile per-id support landed in [#411]; it was previously
single-instance, keyed only by the one webview.)

The one platform difference is **presentation**, not instancing: desktop gives
each instance its own OS window, so N instances can be _visible_ at once. A phone
presents one full-screen native webview at a time, so mobile keeps at most one
instance _visible_ and models presentation as a **z-order stack** (see below).
Non-visible mobile instances stay alive and running (a covered `sniffer` keeps
scraping while `launch` is on screen), exactly like a hidden desktop window.

## Presentation stack (mobile only)

Desktop `show(id)` just reveals that id's window; other windows keep their own
visibility. Mobile can only show one native webview at a time, so it keeps a
**z-order stack** of on-screen instances (`presentationStack`, bottom → top; the
last element is the **frontmost** — the one actually presented). Only the frontmost
is presented in the OS at any moment; everything below it is **covered**:
dismissed-but-alive (its `WKWebView` / `WebView` keeps running/scraping), retained
in the stack purely for reveal ordering.

- **`show(id)`** — a no-op if `id` is already on the stack (frontmost or covered;
  a covered instance is never reordered to the front). Otherwise it **covers** the
  current frontmost — removing it from view but keeping it alive — and presents
  `id` on top. Covering is _not_ a user-facing dismissal, so it emits **no**
  `Hidden`; it does arm the covered instance's idle backstop (it is now
  not-visible). This is what lets a background `sniffer` keep scraping while
  `launch` is on screen.
- **Dismissing the frontmost** (user swipe / Close / system back, or a host
  `hide`) pops it and **reveals the instance beneath** — bringing the previous one
  back to the foreground rather than returning to the app. A dismissal emits
  `Hidden` and arms the dismissed instance's idle backstop (see "User dismissal
  hides" below).
- **`dispose`** of the frontmost tears it down then reveals the one beneath;
  `dispose` of a **covered** instance is a clean in-place teardown that leaves the
  frontmost untouched — there is no OS-level "remove a middle window" to perform,
  because covered instances are not presented.

Platform mechanics differ, the model does not. **iOS** presents at most one
`UINavigationController` sheet at a time; covering dismisses the outgoing sheet and
a reveal **rebuilds a fresh** sheet wrapper around the still-alive controller —
never re-presenting a previously-dismissed wrapper (re-presenting a stale one wedges
UIKit into an unlaunchable state) and re-binding the swipe-to-dismiss delegate each
present. It sequences a cover through the outgoing sheet's animated-dismiss
completion (UIKit rejects presenting while a dismiss animates) and claims the
incoming instance's frontmost state synchronously so a re-entrant `show` during the
animation no-ops rather than double-presenting. **Android** keeps each instance's
`Dialog` across a cover/hide (`Dialog.hide()` leaves the window intact), so covering
is a plain `hide()` and a reveal a plain `show()` — synchronous, no wrapper rebuild.
Either way a covered or dismissed instance is **alive, not disposed** — the "hide
vs. dispose" rule below still holds.

[#411]: https://github.com/wildflowerhealthio/Wildflower/issues/411

## Visibility, liveness, and existence are independent

A native webview has three orthogonal states, and the command surface keeps them
separate:

- **exists** — the instance (webview + chrome + channel binding) is built.
- **is visible** — it is currently on screen.
- **is alive / running** — its JS, timers, and network keep executing.

`open_url` builds (if absent) and navigates **without** presenting — a background
sniff never steals focus. `show` presents. `hide` removes from view but keeps the
instance **alive and running**. Only `dispose` (or a teardown backstop) frees it.
So a hidden instance is still live and still sniffing; "not visible" ≠ "torn
down". This is why the backends track `is_visible` explicitly instead of reading
it off the dialog/window/controller — `dialog.isShowing` and friends conflate
visibility with existence.

## User dismissal hides; only `dispose` tears down

Every user-facing dismissal affordance routes to **hide**, keeping the instance
alive so a later `open_url`/`show` reuses it. Only an explicit host `dispose`, or
a teardown backstop, destroys it. The affordances, per platform:

- **Desktop** — the OS titlebar X. `CloseRequested` fires; the handler
  `prevent_close()`s and hides instead, unless a `dispose()` set `disposing`
  first (see below). App teardown destroys the window through a path that
  bypasses `prevent_close`, so the app-exit backstop still reaches `Destroyed` →
  `Disposed`.
- **iOS** — the Close toolbar button and the interactive sheet swipe-to-dismiss.
  The Close button calls `dismiss(animated:)` then `onUserDismiss`; the swipe is
  reported via `presentationControllerDidDismiss`. UIKit does **not** call
  `presentationControllerDidDismiss` for a programmatic `dismiss`, so the
  button / host-`hide` / host-`dispose` paths (which fire from their own dismiss
  completions) never double-emit with the swipe path.
- **Android** — the Toolbar Close button and system back at the root of history.
  Both call the shared hide path, which uses `dialog.hide()` (NOT `dismiss()`, so
  the dismiss listener — the teardown path — does not fire).

A successful hide emits `NativeWebviewEvent::Hidden`; a teardown emits
`Disposed`. The host's collector treats neither hide nor dispose as the sniff's
terminal signal — the SPA owns `SniffingComplete` — so the bridge re-emits
nothing for these lifecycle events.

## The dispose→open "switch-demo" race

Switching demos fires, on one main-thread tick: `SniffingComplete` → `dispose()`
→ `RequestSniffableWebView` → `open_url()`. The teardown a `dispose()` starts is
**asynchronous** (it only enqueues the actual destroy — `WindowMessage::Close` on
desktop, the dismiss animation/listener on mobile), so the same-tick `open_url()`
would otherwise find a still-present-but-doomed instance and re-wire it, only for
the queued teardown to then destroy what the user just asked to see.

The guard, identical in shape across platforms:

1. `dispose()` sets a `disposing` / `isDisposing` flag **before** asking the
   runtime to tear down.
2. A same-tick `open_url()` that sees the flag set does **not** re-wire the doomed
   instance — it stashes a deferred replay (the desktop `pending_reopen` payload;
   the mobile `onDisposeFinishedHandler` closure) and returns.
3. The teardown's completion handler (desktop `CloseRequested`/`Destroyed`, iOS
   `handleDisposed`, Android dismiss listener) consumes the deferred replay: if
   present, it cancels/absorbs the teardown and rebuilds with the new wiring **and
   suppresses the `Disposed` echo** (the caller logically continued, it did not
   tear down); if absent, the teardown proceeds and emits `Disposed`. The deferred
   payload carries its cookies, so on desktop the replay re-seeds them onto the
   reused content webview (`about:blank` → seed → target-navigate — the same
   order, and the same seeding path, a non-deferred cookie open uses) rather than
   `open_url` seeding the doomed pre-dispose webview.
4. The flag is cleared on that same completion, so later calls aren't stuck in the
   deferral branch.

Crucially a **hide** never arms this flag — a hidden instance stays alive, so a
same-tick `open_url()` during a hide animation simply re-wires it in place. Mobile
also holds the deferred replay's `Invoke` separately (`pendingInvoke`) so a second
`open_url()` superseding a still-queued one can reject the superseded invoke
rather than leaving its JS promise hung forever (there is no timeout on
`open_url`).

## Cookie seeding must not pump the main run loop

A cookie-carrying `open_url` parks the content webview at `about:blank`, writes
the cookies, and navigates to the real target from the writes' completion. The
ordering is the easy half. The hard half is macOS-specific, and it is a
**deadlock**, not a race.

wry's `Webview::set_cookie` is not a fire-and-forget write on macOS. It calls
`wait_for_blocking_operation`, which spins the main run loop with
`-[NSRunLoop acceptInputForMode:beforeDate:]` until WebKit's `setCookie`
completion fires. tauri delivers `WebviewMessage::SetCookie` on the main thread
from inside tao's event handler, and that handler holds tao's
`Handler.callback: Mutex` — a plain, non-reentrant `std::sync::Mutex`. The nested
pump flushes whatever the run loop has queued; if that includes a pending
Core-Animation transaction, the layer display re-enters tao through `draw_rect` →
`handle_nonuser_event`, which takes **the mutex the outer frame already holds**.
The main thread parks in `__psynch_mutexwait` and never comes back: no spinner,
no recovery, force-quit only.

This is why it looked intermittent and cold-launch-only. The deadlock needs a
dirty CA layer pending at the instant of the pump; a cold launch is still
building the popup window and its two child webviews (the launch log's two
`web content process terminated` lines), so a layer display is reliably queued. A
warm relaunch takes the re-open rewire path onto an already-painted webview, so
usually nothing is pending and nothing hangs.

Seeding from off the main thread does **not** fix this, and the earlier
"fire-and-forget FIFO message" framing of that rule was wrong. Off-main only
changes how `SetCookie` reaches the main thread — a queued user message instead
of an inline call. It still executes on the main thread under tao's lock, and
wry's nested pump is the hazard.

The fix removes the pump rather than trying to schedule around it: on macOS the
plugin writes `WKHTTPCookieStore.setCookie(_:completionHandler:)` itself, on the
main thread but asynchronously, counts the completions, and navigates from the
last one (`desktop/cookie_store.rs`, wired in through
`desktop/cookies.rs::seed_then_navigate`). Completions arrive on ordinary,
non-nested run-loop iterations, so tao's callback mutex is never re-entered and
the deadlock is structurally impossible. The same reasoning applies to reads:
wry's `cookies_for_url` pumps identically, so the post-seed read-back log uses an
async `getAllCookies` too.

Two consequences worth holding onto:

- **`open_url` returns before the cookies commit** and before the target starts
  loading. A caller cannot read the jar back on the next line and conclude
  anything; the plugin logs the read-back from its own completion instead.
- **Either thread may call it now.** The macOS path marshals onto the main thread
  itself, which is what lets the `CloseRequested` deferred replay — which _is_ a
  main-thread tao callback — seed inline instead of spawning a thread and hoping.

Non-macOS desktop targets keep the wry `set_cookie` path (their cookie APIs do
not pump), and iOS/Android already issue the load from their native cookie-write
completion handlers.

## Teardown backstops

A hidden instance is alive but bounded, so an untrusted third-party page can't run
forever after dismissal:

- **Mobile** arms a **5-minute idle** timer (`idleTeardownSeconds` /
  `IDLE_TEARDOWN_MS`) **per instance** whenever that instance exists but is not
  frontmost (covered or dismissed-but-alive); any activity on it (an inbound bridge
  message, or any command carrying its id) resets its timer, and `show`/`dispose`
  cancel it. On fire it auto-`dispose`s that instance. A `sniffer` covered by a
  `show("launch")` therefore has ~5 minutes of idle grace before it's reclaimed —
  reset by its own scrape traffic, so an actively-streaming background scrape stays
  alive.
- **Desktop** has no idle timer; instead it caps **absolute lifetime at 15
  minutes** (`ABSOLUTE_TIMEOUT`) from each `open_url` (fresh build or reopen),
  hidden or not. A generation counter (`InstanceState::timeout_generation`) makes a
  reopen/teardown supersede the previously-armed timer, so a stale timer is a
  no-op. On fire it disposes like a host `dispose()`.

Both ultimately route through `dispose`, so the host's collector sees the same
terminal `Disposed`.

## Chrome URL-fallback

The native chrome has three caller-facing labels — **title**, **subtitle**,
**message** — plus the live page URL. The page URL is painted into the **highest
slot the caller has not yet claimed**: the title until the caller supplies a
`title`, then the subtitle until the caller supplies a `subtitle`, then neither
(both caller-owned). A caller value of any kind — including `""` — _claims_ that
slot (and `""` clears the visible label); `null`/absent leaves it unchanged.

State per instance: the live `currentUrl` (updated on navigation), and
`titleClaimed` / `subtitleClaimed` flags. `applyWindowText` records claims and
sets caller values; `renderUrlFallback` paints the URL into the highest unclaimed
slot; navigation calls back into `renderUrlFallback`. All three reset on a fresh
build or a reopen (URL back in the title). The desktop backend bakes the initial
state into the chrome's `data:`-HTML so the bar is correct on first paint (no
post-open patch race); mobile applies it before presenting. Caller-claimed slots
are never overwritten by the fallback.

## Re-open rewire

A second `open_url` against a still-live instance (the common "switch demos" tail,
or a sniffer-driven navigation) **reuses** the webview rather than rebuilding it:

- The event `Channel` is rebound to the new caller's channel, so subsequent
  events (including the eventual `Hidden`/`Disposed`) reach the latest caller.
- The caller's `init_script` is re-applied: `eval`'d into the current page (so
  **not** document-start for the already-loaded page — a documented caveat) and
  re-registered as the document-start script for future loads. Mobile removes the
  prior document-start script first so repeated reopens don't stack N copies (the
  sniffer would otherwise double-hook `fetch`/XHR).
- The chrome URL-fallback claim state resets and the caller's initial chrome
  re-applies (a reopen is logically a fresh open).
- Back/forward history **persists** across the in-place navigation (it pushes a
  new entry), so "Back" stays correct; only the forward-stack bookkeeping is
  reset.
