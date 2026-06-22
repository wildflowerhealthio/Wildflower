# TODO — `tauri-plugin-native-webview` follow-ups (#7 re-wire, #10 race guard)

> **Temporary handoff doc.** Delete it once both tasks land. It is written for an
> agent with **no prior context** on PR #229 (`claude/native-webview-popups-j7hyh1`,
> "Native web view popups"). Read it top to bottom before touching code.

## ⚠️ Hard constraint: you MUST work in the devcontainer

The session that wrote this had **no toolchain** in its container (`vp`, `node_modules`,
`esbuild`, `cargo`, Xcode, Android SDK all absent), so **none** of these two tasks could
be compiled or tested. Do not repeat that. Both tasks are intricate, multi-backend
concurrency/wiring changes — **build and test every change** before pushing:

- Rust: `cargo build` / `cargo nextest` for `tauri-plugin-native-webview` and
  `browser-sniffer-tauri-rust` (needs GTK/WebKit dev libs — present in the devcontainer,
  absent on the plain CI-for-web Linux host).
- iOS (Swift): compile on a Mac with Xcode.
- Android (Kotlin): compile with the Android SDK.
- TS: `vp check` && `vp test` from the repo root (run `vp install` first).
- Linking native sources into the app: `cargo tauri ios init` / `cargo tauri android init`
  from `apps/wildflower-tauri` regenerates `gen/{apple,android}`.

**Wire-contract invariant:** the `open` argument shape must stay in lockstep across
three places — Rust `OpenRequest` (camelCase serde) ⇄ Swift `OpenArgs: Decodable` ⇄
Kotlin `OpenArgs` (`@InvokeArg`). Drift silently breaks decoding on-device.

## What the plugin is (orientation)

`plugins/tauri-plugin-native-webview/` presents an external URL in a **native,
JS-injectable webview popup** with native chrome. One `open(url)` command, three backends:

| Platform | Backend | File |
| --- | --- | --- |
| iOS | Swift `WKWebView` in a `UINavigationController` (`.pageSheet`) | `ios/Sources/NativeWebviewPlugin.swift` |
| Android | Kotlin `android.webkit.WebView` in a `Dialog` + `Toolbar` | `android/src/main/java/com/plugin/nativewebview/NativeWebviewPlugin.kt` |
| Desktop | Tauri `WebviewWindow` with chrome + content child webviews (`add_child`) | `src/desktop.rs` |

Shared Rust: `src/models.rs` (wire shapes: `OpenRequest`, `SetChromeRequest`,
`PopupEvent`), `src/commands.rs` (IPC commands), `src/mobile.rs` (forwards to
Swift/Kotlin via `run_mobile_plugin`), `src/lib.rs`.

The **browser-sniffer** is the only caller today. Its Rust host lives in
`slices/browser-sniffer/browser-sniffer-tauri-rust/src/`:
- `lib.rs` — `attach_browser_sniffer` registers `app.listen(BRIDGE_EVENT, …)` (the bridge
  listener; **runs on the main thread** — relevant below).
- `sniffer_window.rs` — `open_or_navigate(app, url)` calls `native_webview().open(…)`.
- `handlers/sniffing_complete.rs` — `handle(app)` calls `native_webview().close()`.
- `popup_bridge.rs` — `PopupChannel` managed state + `dispatch_body` (popup→host events).

Popup→host events flow over a long-lived `Channel<PopupEvent>` embedded in `OpenRequest`.
For the sniffer this channel is **cloned from one long-lived instance** (same `Arc`-backed
handler) and the `initScript` is a **fixed compile-time bundle** — i.e. they are identical
on every `open`. That is why both tasks below are no-ops for the sniffer and only matter
for other/future callers; implement them for correctness, not because the sniffer breaks.

---

## TASK #7 — re-wire a second `open()` in place

### Problem
When a popup is already up, a second `open()` navigates the existing webview to the new
URL but **silently discards the new call's `channel` and `initScript`** — the popup keeps
its original wiring. A caller that opens with a *different* channel after the first popup
is up will have its events routed to the stale first channel, and its new document-start
script never runs.

Current "already open" branches:
- Desktop: `src/desktop.rs` `present()` — `if let Some(content) = app.get_webview(CONTENT_WEBVIEW_LABEL) { content.navigate(parsed)?; return Ok(()); }`
- iOS: `open()` — `if let existing = self.currentWebView { existing.load(URLRequest(url: url)); … }`
- Android: `open()` — `if (existing != null) { existing.loadUrl(args.url) }`

### Decision (chosen by the maintainer): **re-wire in place**
On a second `open`, navigate AND rebind the channel + re-inject the new `initScript`
(+ re-apply the initial chrome from `OpenRequest`, see Task #3 context below).

### Per-backend implementation notes

**Desktop (`src/desktop.rs`):** the `Channel<PopupEvent>` is captured *by move* into the
`on_window_event` closure in `install_window_listeners` (the `Destroyed` arm does
`channel.send(PopupEvent::Closed)`). To rebind it you must move the channel into
window-managed state so the closure reads the *current* one:
- Add `struct CurrentChannel(Mutex<Channel<PopupEvent>>)`; `window.manage(...)` it in
  `present()`; have the `Destroyed` arm read `window.try_state::<CurrentChannel>()`.
- In `present()`'s "already open" branch: update the stored channel, `navigate`, and
  re-apply initial chrome (it already has `set_chrome`-equivalent via the chrome JS
  `__nativeWebviewSetChrome`, or just `eval` it).
- `initialization_script` is set at webview-build time and only runs at document-start for
  *that* webview's future loads. For an *existing* content webview a new `initScript` can't
  become document-start without rebuilding; either `eval` it now (NOT document-start — note
  the caveat) or rebuild the content webview. Decide and document.

**iOS (`ios/Sources/NativeWebviewPlugin.swift`):** `PopupMessageBridge` holds `let channel`
and is added to the `WKUserContentController`; the plugin keeps no reference to it. To
rebind: store the bridge (e.g. `private weak var currentBridge`), change its `channel` to
`var`, update it on re-open. Re-inject the new script via `addUserScript` (document-start
for future loads) and/or `evaluateJavaScript` now. Apply initial chrome via the existing
`updateTitle/updateSubtitle/updateMessage`.

**Android (`android/.../NativeWebviewPlugin.kt`):** `Bridge` holds `private val channel`
and is added via `addJavascriptInterface`. Make the channel updatable (store the `Bridge`
or re-`addJavascriptInterface`); re-inject via `WebViewCompat.addDocumentStartJavaScript`
(future loads) and/or `evaluateJavascript` now. Apply initial chrome via `toolbar.title/
subtitle` + `messageView.text`. NOTE the existing stale-`currentWebView` concern: it is
only cleared in `setOnDismissListener`; if the dialog is torn down by a non-dismiss path
(config change / process restart) `currentWebView` is left non-null pointing at a dead
WebView. Consider guarding the "already open" branch with `dialog?.isShowing == true`.

### Tests
- Rust: extend the `models.rs` serde drift tests if you change `OpenRequest`.
- Native: no in-repo unit harness for Swift/Kotlin — verify on device.

---

## TASK #10 — guard the close→reopen race ("switch demos")

### Problem
Desktop `present()` dedupes by `app.get_webview(CONTENT_WEBVIEW_LABEL)`, which still finds
a **closing** window for several event-loop ticks after `close()`. The SPA "switch demos"
flow emits `SniffingComplete` (→ `sniffing_complete::handle` → `close()` → `window.close()`,
which only *queues* teardown) immediately followed by a fresh `RequestSniffableWebView` (→
`open_or_navigate` → `present()`). The reopen's `get_webview` finds the doomed window and
navigates it in place — then the queued close destroys it, so the user never sees the new
sniffer. Both events run sequentially on the **main-thread** bridge listener, so the close
is still only queued (not processed) when the reopen runs → the race is reliable, not rare.

### History / what's already done
- The old guard was `SNIFFER_OPEN: AtomicBool` in `sniffer_window.rs` (flip-to-false
  before close so a reopen takes the build-fresh path). The plugin migration made it
  **vestigial** (it was written but never read — `present()` dedupes via `get_webview`,
  not the sentinel), and this PR **removed** it (commit `1367985`). Removing it was
  behaviour-neutral; the race already existed in the PR.

### The blocker (why it isn't already fixed)
A clean guard needs to either stop reusing the closing window OR stop the close — but:
- Tauri `WebviewWindow::close()` can't be cancelled mid-flight.
- There's no reliable "is-closing" signal to inspect on the webview/window.
- Rebuilding fresh during the close **collides on the fixed window label**
  (`WINDOW_LABEL = "native-webview"`, `CHROME_WEBVIEW_LABEL`, `CONTENT_WEBVIEW_LABEL`).

### Approaches to evaluate (in the devcontainer)
1. **Cancelable close.** Handle `WindowEvent::CloseRequested` + `api.prevent_close()` and
   track a "close pending"/"reopen pending" flag so a reopen cancels the pending close and
   navigates instead. **First verify** whether a programmatic `window.close()` fires
   `CloseRequested` in this Tauri version (2.x w/ `unstable` + `webview-data-url`).
2. **Unique per-open labels.** Suffix the three labels with a monotonic counter so a
   rebuild never collides with a closing window; store the current label-set in managed
   state for `send` / `set_chrome` / `close` lookups. More invasive but avoids the
   collision and the cancel question entirely.
3. **Closing flag + deferral.** Set a flag in `close()`, clear on `Destroyed`; `present()`
   waits for destruction before building fresh (needs async/deferral).

### Reuse / altitude note
`slices/shared-structures/shared-structures-tauri-rust/src/sandboxed_webview.rs` already
implements a **generalized** version of this exact pattern (`SANDBOXED_OPEN` sentinel +
`mark_closed` + `open_or_navigate`, from the tunnel work). Consider whether the sniffer /
plugin should adopt or share that abstraction rather than each re-deriving a guard. (That
file's comment at ~line 29, "Mirrors the sniffer's `SNIFFER_OPEN` rationale", is now a
dangling reference and should be fixed when you touch this area.)

### Mobile
Check whether iOS/Android have the analogous race (a reopen during the dismiss animation,
before `currentWebView`/`currentController` clear). Likely milder (weak refs nil out), but
verify and apply the same guard shape if needed.

---

## Stale docs to update (the PR migrated to the plugin but didn't doc-update)

1. `slices/browser-sniffer/docs/Tauri Host Explanation.md` — describes the **old** pre-PR
   architecture wholesale (`WebviewWindow`, in-page `BrowserTopBar`, `__TAURI__` exposure,
   the `SNIFFER_OPEN` race fix). Rewrite for the plugin world: native bridge transport, no
   in-page top bar, no `__TAURI__` on mobile, plugin-owned chrome, and the corrected race
   story (whichever guard you land for Task #10). The "Race between `SniffingComplete` and
   a follow-up open" section currently documents the removed `SNIFFER_OPEN`.
2. `slices/shared-structures/shared-structures-tauri-rust/src/sandboxed_webview.rs` (~L29) —
   fix the dangling "sniffer's `SNIFFER_OPEN`" reference.

## Appendix — other review findings deferred (not part of #7/#10, FYI only)
From the same code review, surfaced but not prioritized for fixing:
- Desktop `open()` still logs (doesn't return) window-build failures — only the URL parse
  error propagates (full propagation needs a non-deadlocking way to return a main-thread
  result; the bridge listener is on the main thread).
- Android `onPageStarted` initScript fallback (when `DOCUMENT_START_SCRIPT` is unsupported)
  injects too late to wrap early synchronous `fetch`/XHR → under-collection, no error.
- `native-bridge.ts` `makeNativeBridgeEventBus` reassigns the single global
  `__nativeWebviewReceive` per construction; a second construction in one JS context would
  orphan prior listeners (low probability — each navigation is a fresh global).
- Desktop chrome back/forward/refresh buttons are never disabled to reflect nav state
  (unlike iOS KVO / Android `onPageFinished`).
