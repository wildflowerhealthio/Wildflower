# tauri-plugin-native-page-browser — Explanation

## What this is

A Tauri v2 plugin that opens an external URL in the **system's in-app browser**,
presented as a **native page**, and tells Rust when the user closes it.

It exposes one command, `open(url, closed)`, with a backend per platform:

- `url` must be `http(s)`; anything else (`javascript:`, `file:`, `data:`, …) is rejected before any backend sees it (`src/url_scheme.rs`).
- `closed` is a `Channel<BrowserEvent>`. On iOS and Android it hears exactly one `BrowserEvent::Closed` (`{"event":"closed"}`) per `open` that succeeds, and none after one that returns an error: when the user closes the view (close button, edge swipe, system back), or when a newer `open` replaces it. Desktop never sends one.

The caller can't script the page, read it, or navigate an open view. It learns that a view opened and that it closed, nothing else.

| Platform | Backend                                    | Presentation                                                                                                                                | Close report                                                   |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| iOS      | Swift `SFSafariViewController`             | Default presentation (slides in from the right); `.close` dismiss button; bar and controls in the app's palette                             | `safariViewControllerDidFinish`, or the plugin's own dismissal |
| Android  | Kotlin `androidx.browser` Custom Tab       | Slides in from the right and out to the right; toolbar in the app's palette, light and dark; back-arrow close icon; URL bar hides on scroll | Session `TAB_HIDDEN`, or the host activity's next resume       |
| Desktop  | Default browser, via `tauri-plugin-opener` | A browser tab                                                                                                                               | None                                                           |

## Why

Launches open in the system's in-app browser so the app can't script the pages where people sign in (RFC 8252): the credentials typed into a server's sign-in page never pass through the app. Two existing plugins open one, and neither gives the host what it needs:

- **A close report to Rust.** The unit runner's `WhileOpen` run policy counts an open launch as the app being present, so the host has to hear when the view closes, in Rust. `tauri-plugin-opener`'s `openUrl(url, "inAppBrowser")` never reports a close; `tauri-plugin-in-app-browser` reports it only to JS.
- **A native page, not a sheet.** The view slides in from the right like a pushed page and goes back with a back button, an edge swipe or system back, in the app's colours. `tauri-plugin-opener` takes no options; `tauri-plugin-in-app-browser` takes one control tint and a presentation style, and nothing on Android.

`tauri-plugin-native-webview` is the other way the host shows external pages. It is the app's own web view, which injects script into the page; this plugin is for the pages the app must not be able to see into.

## One view at a time

A phone shows one in-app browser view. An `open` while a view is showing replaces it: the showing view reports `Closed` on its own channel, then the new view is presented.

- **iOS** dismisses the showing `SFSafariViewController` from its presenter, sends its `Closed` from the dismissal's completion, then presents the new one from the top of Tauri's root view controller. An `open` that arrives while a view is still animating in or out is rejected, because UIKit ignores a dismiss or present started mid-transition and never calls its completion.
- **Android** can't close a Custom Tab programmatically. It reports the showing view's `Closed`, then brings the host activity back to the front (`FLAG_ACTIVITY_CLEAR_TOP | FLAG_ACTIVITY_SINGLE_TOP`), which finishes the tab above it in the task. The new view launches on the host's next resume. Views only ever launch with the host activity in front, so an `open` that arrives while the app is in the background also waits for the next resume (Android blocks activity starts from the background anyway); a newer `open` replaces a waiting one, which still reports its one `Closed`.

## How Android hears the close

A Custom Tab runs in the browser's process, so the plugin has two signals:

- **`TAB_HIDDEN`.** The plugin binds the Custom Tabs service when it loads. When the service is connected, each view gets its own `CustomTabsSession`, whose callback reports `Closed` on `TAB_HIDDEN`. A session per view means a replaced view's late `TAB_HIDDEN` reaches that view, not the one replacing it.
- **The host's resume.** A view launched without a session, including the `ACTION_VIEW` fallback to the default browser when no Custom Tabs provider is installed, reports `Closed` when the host activity next resumes after the view came up over it. The resume also backs up a session whose `TAB_HIDDEN` never arrives.

Each view reports at most once, whichever signal gets there first.

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
│   ├── error.rs               — Error (InvalidUrl; PluginInvoke on mobile / Internal on desktop)
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
[Rust] commands::open → NativePageBrowserExt::open → url_scheme::parse_http_url → platform backend
      │
      ├─ iOS/Android: run_mobile_plugin("open", { url, closed })
      │     → close the showing view, if any → channel.send({ event:"closed" }) on ITS channel
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

The Rust wire shapes and URL validation are covered by unit tests in
`models.rs` and `url_scheme.rs`. The presentation and the close reports are
checked by hand on each device: the view slides in from the right in the app's
colours; close, an edge swipe and system back each return to the app and report
`Closed` once; a second `open` replaces the first and reports `Closed` for it.
