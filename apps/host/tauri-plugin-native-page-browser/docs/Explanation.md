# tauri-plugin-native-page-browser — Explanation

## What this is

A Tauri v2 plugin that opens an external URL in the **system's in-app browser**,
presented as a **native page**, and tells Rust when the user closes it.

It exposes one command, `open(url, closed)`, with a backend per platform. `open` is async on every platform: iOS answers from the main thread, so a caller awaits it rather than blocking on it.

- `url` must be `http(s)`; anything else (`javascript:`, `file:`, `data:`, …), or a string that doesn't parse, returns `Error::InvalidUrl` before any backend sees it (`src/url_scheme.rs`). A backend gets the parsed URL, normalised (leading and trailing spaces trimmed, tabs and newlines removed), not the caller's string.
- `closed` is a `Channel<BrowserEvent>`. On iOS and Android it hears exactly one `BrowserEvent::Closed` (`{"event":"closed"}`) per `open` that succeeds, and none after one that returns an error: when the user closes the view (close button, edge swipe, system back), or, on iOS, when a newer `open` replaces it. Desktop never sends one.

The caller can't script the page, read it, or navigate an open view. It learns that a view opened and that it closed, nothing else.

| Platform | Backend                                    | Presentation                                                                                                                                | Close report                                                   |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| iOS      | Swift `SFSafariViewController`             | Default presentation (slides in from the right); `.close` dismiss button; bar and controls in the app's palette                             | `safariViewControllerDidFinish`, or the plugin's own dismissal |
| Android  | Kotlin `androidx.browser` Custom Tab       | Slides in from the right and out to the right; toolbar in the app's palette, light and dark; back-arrow close icon; URL bar hides on scroll | The host activity's next resume                                |
| Desktop  | Default browser, via `tauri-plugin-opener` | A browser tab                                                                                                                               | None                                                           |

## Why

Launches open in the system's in-app browser so the app can't script the pages where people sign in (RFC 8252): the credentials typed into a server's sign-in page never pass through the app. Two existing plugins open one, and neither gives the host what it needs:

- **A close report to Rust.** The unit runner's `WhileOpen` run policy counts an open launch as the app being present, so the host has to hear when the view closes, in Rust. `tauri-plugin-opener`'s `openUrl(url, "inAppBrowser")` never reports a close; `tauri-plugin-in-app-browser` reports it only to JS.
- **A native page, not a sheet.** The view slides in from the right like a pushed page and goes back with a back button, an edge swipe or system back, in the app's colours. `tauri-plugin-opener` takes no options; `tauri-plugin-in-app-browser` takes one control tint and a presentation style, and nothing on Android.

`tauri-plugin-native-webview` is the other way the host shows external pages. It is the app's own web view, which injects script into the page; this plugin is for the pages the app must not be able to see into.

## One view at a time

A phone shows one in-app browser view. What an `open` does while a view is showing differs by platform:

- **iOS** replaces the showing view. It dismisses the showing `SFSafariViewController` from its presenter, sends its `Closed` on its own channel from the dismissal's completion, then presents the new one from the top of Tauri's root view controller. An `open` that arrives while a view is still animating in or out is rejected, because UIKit ignores a dismiss or present started mid-transition and never calls its completion.
- **Android** can't replace a view: a Custom Tab can't be closed programmatically, and bringing the host back over it is an activity start the system blocks while another app's activity is in front. It doesn't need to, though: a showing view covers the host, so an `open` from the app can only arrive while the view is still launching (a second tap before the tab slides in). That `open` joins the launching view instead of launching another, so it doesn't open its own URL, resolves at once, and hears its `Closed` when that view closes. An `open` that arrives while the host activity isn't in front is rejected, since Android blocks activity starts from the background. Every other `open` launches its view before it resolves.

## How Android hears the close

A Custom Tab runs in the browser's process, so the plugin watches the host activity instead. Launching a view pauses the host under it; when the host next resumes, the view is gone, and the plugin reports its `Closed` to every `open` that launched or joined it. The `ACTION_VIEW` fallback to the default browser, when no Custom Tabs provider is installed, closes the same way.

The plugin hears the host pause and resume through `Application.registerActivityLifecycleCallbacks`, filtered to the host activity, not through `Plugin.onPause` / `onResume`. Tauri's generated `TauriActivity` defines `TauriLifecycleObserver`, which forwards those, but never registers it, so they never run. Even registered, it would observe `ProcessLifecycleOwner`, which reports the whole process and delivers a pause about 700 ms late.

The tab lives in the host's task, so switching apps from it mid-sign-in (to a password manager or an authenticator) and back returns to the tab, not the host: the host doesn't resume, and the view stays open. The host's activity is `singleTop` for the same reason: a `singleTask` one would finish the tab whenever the user taps the launcher icon.

## Colours

The palette is the host's `--color-background` (bar / toolbar) and `--color-neutral-1` (controls, close icon), the same values as `tauri-plugin-native-webview`'s `WildflowerColor`. Native code can't read the web app's CSS, so each backend carries its own copy.

- **iOS** resolves the dynamic colours against the presenting controller's appearance when the view opens: the view renders out of process, so it gets plain colours.
- **Android** hands the Custom Tab a light and a dark colour scheme and lets it follow the system. The close icon is a bitmap, so it takes the current appearance's colour when the view opens.

## Shape

```text
apps/host/tauri-plugin-native-page-browser/
├── Cargo.toml                 — links, tauri-plugin build dep, url, tauri-plugin-opener (desktop)
├── build.rs                   — COMMANDS=["open"], ios_path + android_path
├── permissions/default.toml   — default grant = open (hand-authored open.toml)
├── src/
│   ├── lib.rs                 — init(), NativePageBrowserExt, plugin wiring
│   ├── commands.rs            — the open IPC command
│   ├── models.rs              — OpenRequest, BrowserEvent + wire-shape tests
│   ├── error.rs               — Error (InvalidUrl; PluginInvoke on mobile / OpenDefaultBrowser on desktop)
│   ├── url_scheme.rs          — http(s)-only URL parse/validate, shared by both backends
│   ├── desktop.rs             — opens the default browser through tauri-plugin-opener
│   └── mobile.rs              — registers + forwards open to the Swift (iOS) / Kotlin (Android) plugin
├── ios/
│   ├── Package.swift
│   └── Sources/NativePageBrowserPlugin.swift
└── android/
    ├── build.gradle.kts · settings.gradle · proguard-rules.pro · .gitignore
    └── src/main/
        ├── AndroidManifest.xml — the Custom Tabs service <queries> entry
        ├── java/io/wildflowerhealth/nativepagebrowser/NativePageBrowserPlugin.kt
        └── res/ — anim/ (slide in/out) and drawable/npb_ic_arrow_back.xml
```

## Round trip

```text
[caller (Rust or JS)]  open(url, closed: Channel<BrowserEvent>)
      │
      ▼
[Rust] commands::open → app.native_page_browser().open → url_scheme::parse_http_url → platform backend
      │
      ├─ iOS/Android: run_mobile_plugin_async("open", { url, closed }).await
      │     → iOS: dismiss the showing view, if any → channel.send({ event:"closed" }) on ITS channel
      │       Android: reject if the app is in the background; join a view still launching
      │     → present SFSafariViewController / launch the Custom Tab
      │     → user closes it → channel.send({ event:"closed" }) → Rust channel handler
      │
      └─ Desktop: tauri_plugin_opener::open_url(url) → default browser; `closed` is dropped unsent
```

## Building / verifying

The native halves cannot be built on Linux, and PR CI compiles neither:

- **iOS**: macOS + Xcode. Linking requires regenerating the iOS project so the
  Swift package is picked up — `cargo tauri ios init` (or the next
  `ios build`/`dev`) from `apps/host/host-app`. Do not hand-edit
  `project.pbxproj`.
- **Android**: the Android SDK + Gradle. Linking requires regenerating the
  Android project (`cargo tauri android init`/`build`) so the Kotlin library is
  included.
- **Desktop `cargo check`**: needs the GTK/WebKit system libs
  (`webkit2gtk-4.1`, `gtk+-3.0`) the Linux desktop target links.

The Rust wire shapes, the error's string form and URL validation (including
desktop's `open` refusing a non-`http(s)` URL) are covered by unit tests in
`models.rs`, `error.rs`, `url_scheme.rs` and `desktop.rs`. The presentation and the close reports are
checked by hand on each device: the view slides in from the right in the app's
colours; close, an edge swipe and system back each return to the app and report
`Closed` once; switching apps from an Android view and back reports nothing. A
second `open` replaces the first and reports `Closed` for it on iOS. On Android
a launch after the first view closed opens a new view, and a double-tapped
launch opens one view whose close reports `Closed` to both.
