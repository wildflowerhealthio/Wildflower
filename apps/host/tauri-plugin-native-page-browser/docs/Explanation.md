# tauri-plugin-native-page-browser — Explanation

## What this is

A Tauri v2 plugin that opens an external URL in the **system's in-app browser**,
presented as a **native page**, and tells Rust when the user closes it.

It exposes two commands, `open(url, view, mode, events)` and `close(view)`, with a backend per platform. Both are async on every platform: iOS answers from the main thread, so a caller awaits them rather than blocking on them.

- `url` must be `http(s)`; anything else (`javascript:`, `file:`, `data:`, …), or a string that doesn't parse, returns `Error::InvalidUrl` before any backend sees it (`src/url_scheme.rs`). A backend gets the parsed URL, normalised (leading and trailing spaces trimmed, tabs and newlines removed), not the caller's string.
- `view` is the caller's name for the view, unique among those it opens; `close(view)` names the view to close by it.
- `mode` (`OpenMode`) says how the view shows beside the views already showing: `replace` or `stack` (see One view, or a stack).
- `events` is a `Channel<BrowserEvent>`. On iOS and Android it hears exactly one `BrowserEvent::Closed` (`{"event":"closed"}`) per `open` that succeeds, and none after one that returns an error: when the user closes the view (close button, edge swipe, system back), or, on iOS, when a newer `replace` open replaces it or `close` closes it or a view under it. On Android it may hear one `BrowserEvent::KeptAlive` (`{"event":"keptAlive"}`) before that, when the view's browser keeps the app alive under it (see Keeping the app alive on Android), and a `BrowserEvent::MovedToBackground` (`{"event":"movedToBackground"}`) and `BrowserEvent::ReturnedToForeground` (`{"event":"returnedToForeground"}`) each time the user leaves the app for the home screen or another app with the view up, and comes back (see How Android hears the app leave under a view). Desktop sends none.

The caller can't script the page, read it, or navigate an open view. It learns that a view opened, whether its browser keeps the app alive, when the app leaves and comes back with it up, and that it closed, nothing else. On iOS it can close a view; a Custom Tab (Android) and a browser tab (desktop) can't be closed by the app, so there `close` returns an error.

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

## Whose cookies a view holds

A server's authorization server issues nothing to a browser without a browser session (its `__Host-browser_session` cookie): it sends that browser to pair first. Which session a view has depends on whose cookies it holds.

- **iOS:** each app's `SFSafariViewController` keeps its own cookies and website data, separate from Safari's. A browser paired in Safari isn't paired in the app's views, and a session the app's views hold isn't in Safari. The host's launches and consent opens go through the server's `/oauth/sign-in`, which hands the view an Owner session first, so they never meet the pairing page.
- **Android:** a Custom Tab shares its browser's cookies, so a session the browser holds rides the tab, and one the tab gets stays in the browser.
- **Desktop:** the default browser's own tab, with that browser's cookies.

On Android and a desktop, then, the Owner session a launch's sign-in hands the view lands in the user's own browser, where any tab on `https://<domain>` holds it. So the Owner session lasts only as long as the server's launch views stay open: once the plugin reports the last of them closed, the host ends the sessions their sign-in codes started, and when the server starts, it ends every Owner session but those of the views still open. The host waits for the last close because a server's views share one cookie jar: a stacked view's sign-in replaces the cookie of the view under it. A desktop hears no close, so a server restart is what ends its sessions there. Leaving the app with a view open and coming back isn't a close, so the session stays, and so does the restart iOS brings when the app returns from a suspend. Ending a session expires it, so the cookie stops working, while each app's own storage and refresh token stay in the browser. The next launch signs the browser in again.

## One view, or a stack

What an `open` does while a view is showing is its mode's, and differs by platform. `replace` keeps one view at a time, as a launch wants; `stack` keeps the views showing under the new one, so a page opened over an app's page (a consent, while the app waits for it) can go away and leave the app's page where it was.

- **iOS** keeps the views it shows in a stack, bottom first, each presented over the ones before it.
  - A `replace` open dismisses the bottom view from its presenter, which takes every view over it down too, sends each one's `Closed` on its own channel from the dismissal's completion, top-most first, then presents the new one from the top of Tauri's root view controller.
  - A `stack` open presents the new one from the top-most view controller, which may be a view of the plugin's, and leaves the others where they are.
  - `close(view)` dismisses the view the caller named the same way, with every view over it, and sends each one's `Closed`. Dismissing a view dismisses whatever is presented over it, so closing a view under another closes both. A view already gone closes nothing, and `close` resolves.
  - An `open` or a `close` that arrives while a view is still animating in or out is rejected, because UIKit ignores a dismiss or present started mid-transition and never calls its completion.
- **Android** can't replace or close a view: a Custom Tab can't be closed programmatically, and bringing the host back over it is an activity start the system blocks while another app's activity is in front, so `close` is rejected. A showing view covers the host, so an `open` from the app can only arrive while the views it finds are still launching (a second tap before the tab slides in), or after the host came back in front, which reports the views it was under closed (as a notification tap can bring it).
  - A `replace` open whose latest view still launching is a `replace` open's joins it instead of launching another, so it doesn't open its own URL, resolves or rejects as the view's own `open` does (once the launch is issued, which may wait for the Custom Tabs session), and hears that view's events. Over a `stack` open's view still launching, it launches its own, so its URL opens.
  - A `stack` open launches its own view, over any still launching. Each tab is an activity in the host's task, so closing the top one reveals the one under it, and the host resumes, reporting every view's `Closed`, only once the last is closed.
  - An `open` that arrives while the app is in the background is rejected, since Android blocks activity starts from the background. The app is in front while its host activity is, or while a view of its own whose browser keeps the app alive is up over the host and the user hasn't left it for the home screen or another app: the app's task is in front then, so a `stack` open launches its view over that one. Under a browser that never binds the keep-alive service, nothing says when the user leaves, so an `open` over its view is rejected. Every other `open` launches its view before it resolves.

## How Android hears the close

A Custom Tab runs in the browser's process, so the plugin watches the host activity instead. Launching a view pauses the host under it; when the host next resumes, the views it was under are gone, and the plugin reports each one's `Closed` to every `open` that launched or joined it. The `ACTION_VIEW` fallback to the default browser, when no Custom Tabs provider is installed, closes the same way.

The plugin hears the host pause and resume through `Application.registerActivityLifecycleCallbacks`, filtered to the host activity, not through `Plugin.onPause` / `onResume`. Tauri's generated `TauriActivity` defines `TauriLifecycleObserver`, which forwards those, but never registers it, so they never run. Even registered, it would observe `ProcessLifecycleOwner`, which reports the whole process and delivers a pause about 700 ms late.

The tab lives in the host's task, so switching apps from it mid-sign-in (to a password manager or an authenticator) and back returns to the tab, not the host: the host doesn't resume, and the view stays open. The host's activity is `singleTop` for the same reason: a `singleTask` one would finish the tab whenever the user taps the launcher icon.

## How Android hears the app leave under a view

A view up over the host keeps the app present, so the host's pause and resume can't say when the user leaves the app and comes back: the host paused as the view covered it, and resumes only once the last view closes. The browser's binding of `KeepAliveService` (see Keeping the app alive on Android) says it instead. Chrome holds the binding while a tab is started, so it lets go of it as the user leaves the tab for the home screen or another app, and binds it again as the tab comes back.

So a let-go while the host isn't in front and a view is up over it sends `MovedToBackground` to every view, and the next binding sends `ReturnedToForeground`. Closing the last tab resumes the host before the tab stops, so that let-go sends nothing; the host's resume after the user left (from the launcher icon, say) ends the departure too. A browser that never binds the service, as one that ignores the keep-alive extra, sends neither.

## A resume that opens its own page

The host's activity can mark the resume it is about to make as one that opens a page of its own (`NativePageBrowserPlugin.markResumeOpeningItsOwnPage()`), as Wildflower's `MainActivity` does for an intent from a tapped notification, whose consent the base then opens. The host's Rust side asks once the app is back (`take_resume_opening_its_own_page`, the Kotlin `takeResumeOpeningItsOwnPage` command), which forgets the mark, so the arrival opens no page besides. A mark nothing takes is forgotten when the host next pauses. iOS and desktop never mark one.

## Keeping the app alive on Android

Under a Custom Tab, Android ranks the host as a cached app: the tab's activity is the browser's process, not the host's. A few seconds in, Android blocks a cached app's network and destroys its sockets (`Software caused connection abort`), which drops the servers' tunnels while the user is in the page those servers serve.

The Custom Tabs keep-alive extra, `android.support.customtabs.extra.KEEP_ALIVE`, asks the browser to bind a service of the app's while the tab is open. Chrome honours it, but only for a tab launched from a Custom Tabs session. So the plugin binds the provider's Custom Tabs service when it loads, creates a session, and launches every tab from it with the extra naming `KeepAliveService`. While Chrome, in front, holds that binding, Android ranks the host as bound by the top app (`BOUND_TOP`), which keeps its network. The binding also tells the plugin the view is kept alive, and it sends `KeptAlive`. The extra isn't `androidx.browser` API, and another browser may ignore it; that browser's views never send `KeptAlive`.

An `open` that arrives before the session has connected, as one right after the app starts can, waits up to a second for it, then launches without one. That view isn't kept alive.

`KeepAliveService` is exported, since the browser is another app; its binder does nothing. Binding it only raises the app's priority.

What covers a view that isn't kept alive is the host's: the unit runner counts the app as present in the background from the moment a view opens until its `KeptAlive`, and starts its background session (a `shortService` foreground service) for that time. It has to start before the tab launches, since Android won't start one for an app already in the background. See the unit runner's [Design Explanation](../../unit-runner/tauri-unit-runner-rust/docs/Design%20Explanation.md).

## Colours

The palette is the host's `--color-background` (bar / toolbar) and `--color-neutral-1` (controls, close icon), the same values as `tauri-plugin-native-webview`'s `WildflowerColor`. Native code can't read the web app's CSS, so each backend carries its own copy.

- **iOS** resolves the dynamic colours against the presenting controller's appearance when the view opens: the view renders out of process, so it gets plain colours.
- **Android** hands the Custom Tab a light and a dark colour scheme and lets it follow the system. The close icon is a bitmap, so it takes the current appearance's colour when the view opens.

## Shape

```text
apps/host/tauri-plugin-native-page-browser/
├── Cargo.toml                 — links, tauri-plugin build dep, url, tauri-plugin-opener (desktop)
├── build.rs                   — COMMANDS=["open", "close"], ios_path + android_path
├── permissions/default.toml   — default grant = open + close (hand-authored open.toml, close.toml)
├── src/
│   ├── lib.rs                 — init(), NativePageBrowserExt, plugin wiring
│   ├── commands.rs            — the open and close IPC commands
│   ├── models.rs              — OpenRequest, OpenMode, CloseRequest, BrowserEvent (KeptAlive, Closed, MovedToBackground, ReturnedToForeground) + wire-shape tests
│   ├── error.rs               — Error (InvalidUrl; PluginInvoke on mobile / OpenDefaultBrowser, CloseDefaultBrowserTab on desktop)
│   ├── url_scheme.rs          — http(s)-only URL parse/validate, shared by both backends
│   ├── desktop.rs             — opens the default browser through tauri-plugin-opener; close fails
│   └── mobile.rs              — registers + forwards open and close to the Swift (iOS) / Kotlin (Android) plugin
├── ios/
│   ├── Package.swift
│   └── Sources/NativePageBrowserPlugin.swift
└── android/
    ├── build.gradle.kts · settings.gradle · proguard-rules.pro · .gitignore
    └── src/main/
        ├── AndroidManifest.xml — the Custom Tabs service <queries> entry; the exported KeepAliveService
        ├── java/io/wildflowerhealth/nativepagebrowser/NativePageBrowserPlugin.kt
        ├── java/io/wildflowerhealth/nativepagebrowser/KeepAliveService.kt
        └── res/ — anim/ (slide in/out) and drawable/npb_ic_arrow_back.xml
```

## Round trip

```text
[caller (Rust or JS)]  open(url, view, mode, events: Channel<BrowserEvent>)
      │
      ▼
[Rust] commands::open → app.native_page_browser().open → url_scheme::parse_http_url → platform backend
      │
      ├─ iOS/Android: run_mobile_plugin_async("open", { url, view, mode, events }).await
      │     → iOS replace: dismiss the showing views, if any → channel.send({ event:"closed" }) on EACH one's channel
      │       iOS stack: present over the top-most view
      │       Android: reject if the app is in the background (host not in front, no kept-alive view up over it, or the user left it);
      │                replace: join a replace view still launching;
      │                stack: launch another; wait up to 1 s for the Custom Tabs session
      │     → present SFSafariViewController / launch the Custom Tab (with the keep-alive extra)
      │     → Android: the browser binds KeepAliveService → channel.send({ event:"keptAlive" })
      │     → Android: user goes home with the view up → the browser lets go → channel.send({ event:"movedToBackground" })
      │       and comes back to it → the browser binds again → channel.send({ event:"returnedToForeground" })
      │     → user closes it → channel.send({ event:"closed" }) → Rust channel handler
      │
      └─ Desktop: tauri_plugin_opener::open_url(url) → default browser; `events` is dropped unsent

[caller (Rust or JS)]  close(view)
      │
      ├─ iOS: dismiss that view and every view over it → channel.send({ event:"closed" }) on each one's channel
      └─ Android / Desktop: rejected; the app can't close a Custom Tab or a browser tab
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
second `replace` open replaces the first and reports `Closed` for it on iOS; a
`stack` open shows over the first, and closing it, by hand or with `close`,
reveals the first, still on its page, and reports `Closed` for the second only;
`close` of the first with the second over it reports `Closed` for both. On Android
going home with a view up and back to it from the app switcher reports
`MovedToBackground` then `ReturnedToForeground`, closing the view back onto the
app reports neither, and a `stack` open after that return opens over the view.
On Android a launch after the first view closed opens a new view, and a double-tapped
launch opens one view whose close reports `Closed` to both; a `stack` open
while a view launches opens a second tab over it, and the host's resume after
both are closed reports `Closed` for each. With Chrome as the
Custom Tabs provider, `adb shell dumpsys netpolicy` shows the host's uid at
`procState=BTOP` with `effective=NONE` (no network block) while a view is open,
and `adb shell dumpsys activity services <package>` shows Chrome bound to
`KeepAliveService`.
