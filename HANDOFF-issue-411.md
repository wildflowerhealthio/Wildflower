# Handoff — #411 native-webview multi-instance on mobile

Draft-PR handoff for a local agent with compile/test/device access. This branch
(`claude/session-yuwl0x`) implements [#411] but was written in a remote container
that **cannot compile the Rust plugin (no `webkit2gtk`), cannot build the Swift or
Kotlin backends, and cannot run a device/simulator**. Everything below the "What
was verified" line still needs a human/agent with the real toolchains.

> This file is a temporary handoff — delete it before merge.

[#411]: https://github.com/wildflowerhealthio/Wildflower/issues/411

## What the issue asked

Desktop already supports multiple concurrent native-webview instances keyed by a
caller-named `id` (`sniffer`, `launch`); the two shared call sites already pass an
`id`. `mobile.rs` accepted the `id` but **ignored** it, and the iOS/Android
backends were single-instance singletons. #411 = close that gap.

## Design decision (confirmed with the requester)

**Presentation model: foreground swap + N alive-but-hidden instances.** A phone
shows one full-screen native webview at a time, so:

- Each `id` gets its own instance (webview + native chrome + event `Channel` +
  full lifecycle state), stored in a per-`id` map on the native side — mirroring
  desktop's `PluginState`.
- `show(id)` presents that instance and **hides whichever instance was visible**
  (routing it through the normal hide path: emits its `Hidden`, arms its idle
  backstop), keeping it **alive and running**.
- So a hidden `sniffer` keeps scraping while `launch` is on screen, and vice
  versa. This is the mobile analogue of desktop's independent OS windows, and it
  directly satisfies the issue's "background hidden scrape" note (scope item 4).

Other build-scope choice confirmed: implement **both** iOS and Android backends,
the shared Rust, and the docs in this PR (best-effort, untested on device).

## Files changed

Shared Rust (`plugins/tauri-plugin-native-webview/src/`):

- `models.rs` — added `WithId<'a, T>` (flattens `id` + a wrapped request) and
  `IdOnly<'a>` (just `{ id }`), the mobile id-transport wire wrappers, plus two
  host-runnable serde tests (`with_id_flattens_id_alongside_inner_fields`,
  `id_only_serializes_just_the_id`).
- `mobile.rs` — every method now forwards the `id` to the native side: `open_url`
  / `evaluate_js` / `patch_window_text` send `WithId { id, inner: payload }`;
  `show` / `hide` / `dispose` send `IdOnly { id }` (were `()`).
- `commands.rs`, `lib.rs` — doc-comment payload examples updated to include `id`.

iOS (`ios/Sources/NativeWebviewPlugin.swift`):

- Added `id` to `OpenArgs` / `EvaluateJsArgs` / `PatchWindowTextArgs`, plus a new
  `IdArgs { id }` parsed by `show` / `hide` / `dispose`.
- New `NativeWebviewInstance` class holds all former singleton fields (webView,
  controller, bridge, navigation, isVisible, isDisposing, replay handler,
  pendingInvoke, idleTimer).
- `NativeWebviewPlugin` now holds `instances: [String: NativeWebviewInstance]` +
  `visibleId: String?`. All commands + `present` / `handleHidden` / `handleDisposed`
  / `resetIdleTimer` / `cancelIdleTimer` are keyed by `id`.
- New `presentSwapping(toId:instance:)` does the foreground swap: it dismisses the
  outgoing sheet and presents the incoming one **from the dismiss completion**
  (UIKit forbids presenting during an animating dismiss), claiming the incoming
  instance's visibility synchronously so a re-entrant `show` no-ops.
- `NativeWebviewController` / `NativeWebviewMessageBridge` / color + title helpers
  are unchanged (they were already per-instance-friendly).

Android (`android/.../NativeWebviewPlugin.kt`):

- Same arg changes + `IdArgs`.
- New `private inner class Instance(val id)` holds all former singleton fields
  incl. a **per-instance `idleTeardownRunnable`** (Handler callbacks key on the
  Runnable identity, so each instance needs its own).
- `instances: mutableMapOf<String, Instance>()` + `visibleId`. All commands +
  helpers (`hideDialog` / `disposeDialog` / `resetIdleTimer` / `cancelIdleTimer` /
  `applyWindowText` / `renderUrlFallback` / `onNavigate` / `present`) take an
  `Instance` or `id`.
- `show` swap is a plain synchronous hide-then-show (`Dialog.hide()`/`show()` need
  no animation sequencing).
- `onDestroy` disposes **all** instances (snapshots `instances.values.toList()`
  first — the dismiss listener removes from the map under iteration otherwise).

Docs: `Lifecycle and Races Explanation.md` (Instancing rewritten, new "Foreground
swap (mobile only)" section, per-instance idle backstop wording) and
`Explanation.md` (mobile-is-single-instance paragraph replaced).

No change to `build.rs`, `permissions/`, or the command set — still the same six
commands; only their payloads gained an `id` field, and Tauri permissions are
per-command, not per-arg.

## What was verified here (the only things possible)

- `markdownlint-cli2 --config .local.markdownlint-cli2.mjs` passes on both changed
  docs (0 errors). MD049 emphasis style: both docs use `_underscore_`.
- `rustfmt --edition 2021 --check` is clean on `models.rs` / `mobile.rs` /
  `commands.rs` / `lib.rs` (workspace edition is 2021).
- The one real serde uncertainty — that `WithId` with `#[serde(flatten)]` + a
  wrapped struct that uses `skip_serializing_if` produces the right wire shape —
  was confirmed with a standalone serde repro:
  `{"id":"sniffer","url":...,"nativeWebviewEventChannel":"__CHANNEL__:..."}` — `id`
  flattened at top level, `initScript`/`cookies` dropped when absent, no `inner`
  nesting. `IdOnly` → `{"id":"launch"}`.

## What you MUST do locally

1. **Compile the Rust plugin + run its unit tests** in a GTK/WebKit environment
   (or CI): `./scripts/checks/rust.sh` (fmt + clippy `-D warnings` + nextest). The
   two new `models.rs` tests run on host once the crate builds. Watch for clippy
   pedantry on the new code.
2. **Build iOS** (macOS + Xcode) and **Android** (SDK + Gradle) from
   `apps/wildflower-tauri` (`cargo tauri ios build` / `android build`). These were
   written without a compiler in the loop — **expect to fix Swift/Kotlin
   syntax/type slips**. Nothing here is device-verified.
3. **Manual device/simulator test matrix** (iOS + Android):
   - `sniffer` scrape opens, shows, injects, streams bridge messages.
   - Launch an app (`launch`) while a `sniffer` is up → `sniffer` is swapped to the
     background (its `Hidden` fires) and **keeps scraping**; `launch` is foreground.
   - Dismiss `launch` (Close / swipe / system back) → it hides (not disposed);
     re-show works.
   - `dispose(sniffer)` on `SniffingComplete` tears down only `sniffer`, leaving
     `launch` alone (and vice versa).
   - dispose→open "switch-demo" race on a single id still replays correctly.
   - 5-min idle backstop disposes a hidden instance (per instance now).

## Known edge cases to sanity-check on device (couldn't be exercised here)

- **iOS swap sequencing.** `presentSwapping` presents the incoming sheet from the
  outgoing sheet's animated-dismiss completion. Verify no "attempt to present …
  while a presentation is in progress" and no flicker. The incoming instance's
  `isVisible`/`visibleId` are claimed synchronously to block a re-entrant `show`
  during the ~0.3s animation — confirm a rapid `show(a); show(b)` behaves.
- **iOS `topViewController()` after swap.** After the outgoing dismiss completes,
  presenting the incoming from the top VC should land on the root. Confirm it
  doesn't present under a stale VC.
- **Hidden `launch` idle-disposes after 5 min.** `launch` injects no `init_script`,
  so its bridge sees no traffic to reset the idle timer — a backgrounded `launch`
  will auto-dispose ~5 min after being swapped out. That's consistent with the
  backstop's intent, but confirm it's acceptable for the consent flow.
- **Android `CookieManager` is process-global.** Unchanged by this PR, but with two
  live instances the note in `seedCookies` matters more: a seeded cookie is visible
  to every WebView on that host. Only `launch` seeds today, so no cross-instance
  bleed in practice — worth a glance.

## Open questions for the requester (not blockers)

- Should the foreground swap be _automatic_ (as built — `show(b)` hides `a`), or
  should the host be responsible for `hide(a)` before `show(b)`? Automatic was
  chosen so the shared cross-platform call sites stay single-code-path (they just
  `open`+`show` per id and never coordinate visibility). Flag if you'd rather the
  host drive it.
- Is a visible-stack/switcher UI ever wanted on mobile, or is 1-visible-at-a-time
  the permanent model? Current code assumes the latter.
