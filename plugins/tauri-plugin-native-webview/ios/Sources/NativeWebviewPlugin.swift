import Tauri
import UIKit
import WebKit

/// Arguments decoded from `invoke('plugin:native-webview|open_url', { id, url, initScript, nativeWebviewEventChannel })`.
/// Keys match the mobile `WithId<OpenRequest>` camelCase serde wire shape (`id`
/// plus `OpenRequest`'s flattened fields); `initScript` is
/// omitted when absent. `nativeWebviewEventChannel` is a Tauri `Channel<NativeWebviewEvent>`
/// the caller receives native webview events on (`{"event":"message", "payload": …}` /
/// `{"event":"hidden"}` / `{"event":"disposed"}`) — see `models.rs` `NativeWebviewEvent`.
class OpenArgs: Decodable {
  /// Caller-named instance id (e.g. `"sniffer"`, `"launch"`) — routes to the
  /// matching per-id instance in `NativeWebviewPlugin.instances`. Matches the
  /// `WithId` wrapper the Rust `mobile.rs` serialises around `OpenRequest`.
  let id: String
  let url: String
  let initScript: String?
  let nativeWebviewEventChannel: Channel
  /// Initial chrome; omitted keys decode to nil (leave unchanged). Matches
  /// `OpenRequest`'s `initialTitle` / `initialSubtitle` / `initialMessage` wire shape.
  let initialTitle: String?
  let initialSubtitle: String?
  let initialMessage: String?
  /// Cookies to seed into the webview's store BEFORE the first navigation to
  /// `url` (the apps-launch owner-session seeding). Matches `OpenRequest`'s
  /// `cookies` wire shape; the key is omitted (→ nil) when there is nothing to
  /// seed.
  let cookies: [CookieArg]?
}

/// One cookie decoded from `OpenRequest`'s `cookies` entries — camelCase keys
/// matching `CookieSpec`'s serde wire shape. See `models.rs`.
class CookieArg: Decodable {
  let name: String
  let value: String
  /// `Domain` attribute: the cookie applies to this host and its subdomains.
  let domain: String
  let path: String
  let secure: Bool
  let httpOnly: Bool
  /// `"strict"` / `"lax"` / `"none"` — pinned lowercase in `models.rs`.
  let sameSite: String
  /// Lifetime in seconds from now; nil = session cookie.
  let maxAge: Int64?
}

/// Arguments decoded from `invoke('plugin:native-webview|evaluate_js', { id, script })`.
/// Keys match the mobile `WithId<EvaluateJsRequest>` camelCase serde wire shape. The host evaluates
/// `script` verbatim in the native webview — typically a
/// `window.__nativeWebviewReceive(JSON.stringify(...))` call carrying a bridge
/// envelope.
class EvaluateJsArgs: Decodable {
  /// Caller-named instance id — see `OpenArgs.id`.
  let id: String
  let script: String
}

/// Arguments decoded from `invoke('plugin:native-webview|patch_window_text', { id, title?, subtitle?, message? })`.
/// Keys match the mobile `WithId<PatchWindowTextRequest>` camelCase serde wire shape. Each field is
/// optional: `nil` / absent means "leave unchanged"; empty string clears that
/// label. The plugin batches all three to keep multi-field updates flicker-free.
class PatchWindowTextArgs: Decodable {
  /// Caller-named instance id — see `OpenArgs.id`.
  let id: String
  let title: String?
  let subtitle: String?
  let message: String?
}

/// Arguments decoded from the id-only commands `show` / `hide` / `dispose`
/// (`invoke('plugin:native-webview|show', { id })`). Matches the Rust `IdOnly`
/// wrapper the mobile transport serialises for these argument-less commands.
class IdArgs: Decodable {
  let id: String
}

/// Per-native-webview script message handler: holds the caller's [`Channel`] and
/// forwards each `window.webkit.messageHandlers.nativeWebview.postMessage(...)`
/// call as a `NativeWebviewEvent.message` payload. Per-native-webview (not a
/// plugin singleton) so a stacked second `openUrl` doesn't redirect the first
/// instance's events into the second's channel.
///
/// `channel` is `var` for Re-open rewire — see docs/Lifecycle and Races Explanation.md.
///
/// iOS retain note: `WKUserContentController` retains its script-message handlers
/// strongly, and `userContentController.add(handler, name:)` then retains the
/// handler back through the webview's configuration (the cycle that historically
/// required `WeakScriptMessageHandler`). We sidestep it by removing this handler
/// in the controller's `deinit`.
class NativeWebviewMessageBridge: NSObject, WKScriptMessageHandler {
  var channel: Channel
  /// Reset-idle-timer hook (Teardown backstops). Weak-captures the plugin at the
  /// callsite to avoid a retain cycle (the plugin owns the webview graph that
  /// retains this bridge).
  var onActivity: (() -> Void)?

  init(channel: Channel) {
    self.channel = channel
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard message.name == NativeWebviewPlugin.messageHandlerName,
      let payload = message.body as? String
    else { return }

    onActivity?()
    // Forward the injected adapter's opaque JSON string verbatim as a
    // `NativeWebviewEvent.message` (matches `models.rs`). The explicit
    // `JsonObject` annotation pins the non-throwing `send(JsonObject)` overload —
    // without it Swift infers `[String: String]` and picks the throwing
    // `send<T: Encodable>` generic.
    let data: JsonObject = ["event": "message", "payload": payload]
    channel.send(data)
  }
}

/// One native-webview instance's live state, keyed by the caller-named `id` in
/// `NativeWebviewPlugin.instances`. Mirrors the desktop backend's per-id
/// `InstanceState` registry: each instance owns its own `WKWebView`, chrome
/// controller, event bridge, navigation controller, visibility + dispose flags,
/// deferred switch-demo replay, and idle-teardown timer, so a background
/// `sniffer` scrape and a `launch` popup never trample each other's wiring. All
/// the cross-platform lifecycle/race protocols apply per instance. See
/// docs/Lifecycle and Races Explanation.md.
class NativeWebviewInstance {
  /// The `WKWebView`, if any. Held STRONGLY so a hidden instance stays alive;
  /// cleared only in `handleDisposed(id:)`, after which `evaluateJs` rejects.
  var webView: WKWebView?
  /// The chrome controller — target for chrome updates and `show`/`hide`.
  var controller: NativeWebviewController?
  /// The message bridge; its `channel` is rebound on Re-open rewire.
  var bridge: NativeWebviewMessageBridge?
  /// The `UINavigationController` wrapping `controller` — `show` presents and
  /// `hide` dismisses it without teardown.
  var navigation: UINavigationController?
  /// Whether this instance is on screen — tracked explicitly because visibility
  /// and existence are independent (see the doc's first section). At most one
  /// instance is `isVisible` at a time (the foreground-swap invariant, also
  /// tracked by `NativeWebviewPlugin.visibleId`).
  var isVisible = false
  /// The `disposing` flag of the switch-demo race guard: set between a `dispose`
  /// (host or idle backstop) and the `handleDisposed(id:)` that completes
  /// teardown. A same-tick `openUrl` queues a replay only when set; a `hide`
  /// leaves it false and rewires in place.
  var isDisposing = false
  /// Deferred replay armed by the dispose→open switch-demo race: a closure that
  /// presents the fresh instance, run from `handleDisposed(id:)` once teardown
  /// completes (and which then suppresses the `disposed` echo).
  var onDisposeFinishedHandler: (() -> Void)?
  /// The `Invoke` owned by `onDisposeFinishedHandler`, held separately so a
  /// second `openUrl()` superseding a still-queued one can reject it (no timeout
  /// on `openUrl`).
  var pendingInvoke: Invoke?
  /// Idle teardown timer (Teardown backstops). Fires on the main run loop.
  var idleTimer: Timer?

  /// Exists but off screen — the only state the idle backstop reclaims.
  var isHidden: Bool { controller != nil && !isVisible }
}

/// Native webview plugin — iOS backend of the cross-platform lifecycle protocol.
/// See docs/Lifecycle and Races Explanation.md for the shared model; this type implements it
/// with a `WKWebView` inside a `UINavigationController` presented as a page sheet.
///
/// **Multi-instance**: every command takes the caller-named `id` (see
/// `OpenArgs.id`), and each instance's state lives in `instances[id]` — mirroring
/// desktop's per-id registry. A phone presents one full-screen native webview at
/// a time, so `show(id)` performs a **foreground swap**: it hides whichever
/// instance is currently visible (keeping it alive) before presenting `id`.
/// Non-visible instances stay alive and running.
///
/// Orientation: `openUrl` builds (HIDDEN if absent) and navigates without
/// presenting; `show` presents (swapping out the visible instance); `hide`
/// removes from view but keeps the instance alive; `dispose` tears it down. A
/// document-start `WKUserScript` is injected on every origin and each ping is
/// forwarded to that instance's [`Channel`]. See the doc's "Visibility, liveness,
/// and existence are independent" and "User dismissal hides; only `dispose` tears
/// down".
class NativeWebviewPlugin: Plugin {
  /// `window.webkit.messageHandlers.<name>` the injected script posts to.
  static let messageHandlerName = "nativeWebview"

  /// Idle teardown backstop duration (mobile 5-min idle) — see Teardown
  /// backstops in docs/Lifecycle and Races Explanation.md.
  static let idleTeardownSeconds: TimeInterval = 5 * 60

  /// Live instances keyed by caller-named id. An entry is created by `present`
  /// and removed by the terminal branch of `handleDisposed(id:)`. Ids are a small
  /// fixed set (`sniffer`, `launch`), so the map never grows unbounded.
  private var instances: [String: NativeWebviewInstance] = [:]

  /// The id of the instance currently on screen, or `nil` when none is. A phone
  /// shows one native webview at a time; `show` swaps this (hiding the outgoing
  /// instance, presenting the incoming one). Kept in sync with the winning
  /// instance's `isVisible`.
  private var visibleId: String?

  /// Build the `HTTPCookie` for one wire [`CookieArg`]. Returns nil only when
  /// Foundation rejects the property set — unexpected, since every required
  /// key (name / value / domain / path) is always supplied.
  private static func httpCookie(from arg: CookieArg) -> HTTPCookie? {
    var properties: [HTTPCookiePropertyKey: Any] = [
      .name: arg.name,
      .value: arg.value,
      // A plain host (no leading dot) still yields a Domain-attribute cookie
      // here (subdomain-inclusive), matching the other backends' semantics.
      .domain: arg.domain,
      .path: arg.path,
    ]
    if arg.secure { properties[.secure] = "TRUE" }
    // `isHTTPOnly` has no public `HTTPCookiePropertyKey` constant; Foundation
    // recognises the literal "HttpOnly" key (server-set parity, JS can't read it).
    if arg.httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
    if let maxAge = arg.maxAge {
      // Absolute expiry (version-0 semantics) rather than `.maximumAge`, which
      // Foundation only honours for version-1 cookies.
      properties[.expires] = Date(timeIntervalSinceNow: TimeInterval(maxAge))
    }
    switch arg.sameSite {
    case "lax": properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax
    case "strict": properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
    default: break  // "none": no SameSite property — absent means unrestricted
    }
    return HTTPCookie(properties: properties)
  }

  /// Seed `cookies` into `webView`'s cookie store, then run `load` once every
  /// `setCookie` completion has fired — so the seed rides the very first
  /// request to the target (mirrors desktop's blocking `set_cookie` →
  /// `navigate` ordering). No cookies → load immediately. A cookie Foundation
  /// rejects is logged and skipped rather than aborting the open (the page
  /// then just renders unauthenticated, same as before seeding existed).
  private static func seedCookies(
    _ cookies: [CookieArg]?,
    into webView: WKWebView,
    thenLoad load: @escaping () -> Void
  ) {
    guard let cookies = cookies, !cookies.isEmpty else {
      load()
      return
    }
    let store = webView.configuration.websiteDataStore.httpCookieStore
    let group = DispatchGroup()
    for arg in cookies {
      guard let cookie = httpCookie(from: arg) else {
        NSLog("native-webview: dropping unbuildable cookie %@ for %@", arg.name, arg.domain)
        continue
      }
      group.enter()
      store.setCookie(cookie) { group.leave() }
    }
    group.notify(queue: .main, execute: load)
  }

  /// Ensure a native webview exists and navigate it to `url`. Builds HIDDEN if
  /// absent; on an existing instance, Re-open rewire (channel / initScript /
  /// chrome) and navigate in place, PRESERVING current visibility. Never
  /// presents — call `show`. Resolves with `{opened: true}`.
  @objc public func openUrl(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("native-webview: invalid URL \(args.url)")
      return
    }
    let id = args.id

    DispatchQueue.main.async {
      self.resetIdleTimer(id)  // a command counts as activity (no-op if no instance yet)
      let instance = self.instances[id]
      // Dispose→open switch-demo race: a dispose teardown is in flight for THIS
      // id, so queue a replay (run from `handleDisposed(id:)`) instead of
      // re-wiring the doomed instance. A HIDE never arms `isDisposing`, so it
      // falls through to the Re-open rewire branch below. See
      // docs/Lifecycle and Races Explanation.md.
      if let instance = instance, instance.isDisposing {
        // Supersede any already-queued openUrl so its `await` isn't left hung
        // (last-write-wins would otherwise drop its `resolve`).
        instance.pendingInvoke?.reject(
          "native-webview: superseded by a newer open() before the popup finished closing")
        instance.pendingInvoke = invoke
        instance.onDisposeFinishedHandler = { [weak self] in
          guard let self = self else { return }
          self.present(
            id: id,
            url: url,
            initScript: args.initScript,
            channel: args.nativeWebviewEventChannel,
            initialTitle: args.initialTitle,
            initialSubtitle: args.initialSubtitle,
            initialMessage: args.initialMessage,
            cookies: args.cookies
          )
          invoke.resolve(["opened": true])
        }
        return
      }
      // Re-open rewire — existing instance (visible OR hidden), not being torn
      // down: rebind the channel and re-apply initScript/chrome, navigate in
      // place, PRESERVE visibility (do NOT present). The new `initScript` is
      // `eval`'d into the current page and re-registered as document-start for
      // future loads; `reopen` resets the URL-fallback claim state. See
      // docs/Lifecycle and Races Explanation.md.
      if let instance = instance, let existing = instance.webView, let bridge = instance.bridge {
        bridge.channel = args.nativeWebviewEventChannel
        if let initScript = args.initScript {
          existing.evaluateJavaScript(initScript, completionHandler: nil)
          // Drop the prior document-start script before re-adding so repeated
          // reopens don't stack N copies. The plugin adds exactly one user
          // script (the initScript), so clearing all is safe.
          existing.configuration.userContentController.removeAllUserScripts()
          existing.configuration.userContentController.addUserScript(
            WKUserScript(
              source: initScript,
              injectionTime: .atDocumentStart,
              forMainFrameOnly: false
            )
          )
        }
        instance.controller?.reopen(
          url: url.absoluteString,
          title: args.initialTitle,
          subtitle: args.initialSubtitle,
          message: args.initialMessage
        )
        // Seed cookies before navigating so they ride the new target's first
        // request; the resolve stays immediate (`opened` means "navigation
        // dispatched", and the load itself is asynchronous anyway).
        NativeWebviewPlugin.seedCookies(args.cookies, into: existing) {
          existing.load(URLRequest(url: url))
        }
        invoke.resolve(["opened": true])
        return
      }
      // No instance for this id: build one HIDDEN — `present` constructs the
      // webview graph but does not call UIKit `present(_:)` (build/navigate are
      // separate from presentation; see the doc's first section).
      self.present(
        id: id,
        url: url,
        initScript: args.initScript,
        channel: args.nativeWebviewEventChannel,
        initialTitle: args.initialTitle,
        initialSubtitle: args.initialSubtitle,
        initialMessage: args.initialMessage,
        cookies: args.cookies
      )
      invoke.resolve(["opened": true])
    }
  }

  /// Present the native webview — bring a freshly-built or previously-hidden
  /// instance to the foreground as a page sheet. Resolves with
  /// `{requestCausedShow: true}` only when this call actually presented it;
  /// `{requestCausedShow: false}` when none exists or it was already visible (a
  /// transition flag, matching `hide` / `dispose`). Cancels the hidden-idle
  /// teardown backstop (a visible webview is never idle-reclaimed).
  @objc public func show(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      let id = args.id
      guard let instance = self.instances[id] else {
        invoke.resolve(["requestCausedShow": false])
        return
      }
      self.cancelIdleTimer(instance)
      // Dispose teardown in flight: nothing presentable (presenting would race
      // UIKit's dismiss-in-progress no-op and desync `isVisible` on a doomed
      // instance). See "The dispose→open \"switch-demo\" race".
      if instance.isDisposing {
        invoke.resolve(["requestCausedShow": false])
        return
      }
      guard instance.navigation != nil else {
        invoke.resolve(["requestCausedShow": false])
        return
      }
      if instance.isVisible {
        // Already on screen — idempotent, but no transition caused.
        invoke.resolve(["requestCausedShow": false])
        return
      }
      // Foreground swap: a phone shows one native webview at a time, so hide
      // whichever instance is currently visible (keeping it ALIVE and running)
      // before presenting `id`. See docs/Lifecycle and Races Explanation.md.
      self.presentSwapping(toId: id, instance: instance)
      invoke.resolve(["requestCausedShow": true])
    }
  }

  /// Present `instance` (id `id`) as the foreground native webview, hiding the
  /// currently-visible instance first if there is a different one. The outgoing
  /// instance is hidden — not torn down — so it keeps running (a background
  /// `sniffer` keeps scraping while `launch` is shown). UIKit rejects presenting
  /// while a dismiss is animating, so when a swap is needed the incoming present
  /// runs from the outgoing dismiss's completion. Main-thread only.
  private func presentSwapping(toId id: String, instance: NativeWebviewInstance) {
    // Snapshot the outgoing (currently-visible) instance, if a different one.
    var outgoing: (id: String, navigation: UINavigationController)?
    if let currentId = self.visibleId, currentId != id,
      let current = self.instances[currentId], current.isVisible,
      let currentNavigation = current.navigation
    {
      current.isVisible = false
      outgoing = (currentId, currentNavigation)
    }
    // Claim visibility for the incoming instance SYNCHRONOUSLY so a re-entrant
    // `show()` during the outgoing dismiss animation no-ops (sees `isVisible`)
    // instead of double-presenting.
    instance.isVisible = true
    self.visibleId = id
    let present: () -> Void = { [weak self] in
      guard let self = self, let navigation = instance.navigation else { return }
      self.topViewController()?.present(navigation, animated: true)
    }
    if let outgoing = outgoing {
      // UIKit rejects presenting while a dismiss animates, so present the
      // incoming instance from the outgoing dismiss's completion. `handleHidden`
      // emits the outgoing instance's `hidden` + arms its idle backstop (it
      // leaves `visibleId` — now the incoming id — untouched).
      outgoing.navigation.dismiss(animated: true) { [weak self] in
        self?.handleHidden(id: outgoing.id)
        present()
      }
    } else {
      present()
    }
  }

  /// Hide the native webview — remove it from view but keep it alive and
  /// running (do NOT tear it down). Emits `NativeWebviewEvent.hidden` on the
  /// channel and arms the hidden-idle teardown backstop. Resolves with
  /// `{requestCausedHide: false}` when nothing was visible, `{requestCausedHide:
  /// true}` once hidden.
  @objc public func hide(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      let id = args.id
      guard let instance = self.instances[id], instance.isVisible,
        let navigation = instance.navigation
      else {
        invoke.resolve(["requestCausedHide": false])
        return
      }
      // Flip `isVisible` synchronously (mirroring Android's `hideDialog`) so a
      // second `hide()` racing this in-flight animated dismiss sees the new
      // state and no-ops instead of dismissing again and double-emitting
      // `hidden`. `handleHidden(id:)` re-sets it from the dismiss completion,
      // which is idempotent.
      instance.isVisible = false
      if self.visibleId == id { self.visibleId = nil }
      // Host `hide()` shares `handleHidden(id:)` with user dismissal, fired here
      // from the dismiss completion. See "User dismissal hides; only `dispose`
      // tears down".
      navigation.dismiss(animated: true) { [weak self] in
        self?.handleHidden(id: id)
      }
      invoke.resolve(["requestCausedHide": true])
    }
  }

  /// Dispose the native webview — tear it down and free its resources
  /// (controller / WKWebView / bridge). Emits `NativeWebviewEvent.disposed` and
  /// cancels the idle timer. Resolves `{requestCausedDispose: false}` when none
  /// existed, `true` once torn down. See "User dismissal hides; only `dispose`
  /// tears down" in docs/Lifecycle and Races Explanation.md.
  @objc public func dispose(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      let id = args.id
      guard let instance = self.instances[id], let controller = instance.controller else {
        invoke.resolve(["requestCausedDispose": false])
        return
      }
      self.cancelIdleTimer(instance)
      // Arm the switch-demo race guard before teardown; cleared in
      // `handleDisposed(id:)`. See "The dispose→open \"switch-demo\" race".
      instance.isDisposing = true
      controller.requestDispose(wasVisible: instance.isVisible)
      invoke.resolve(["requestCausedDispose": true])
    }
  }

  /// (Re)arm instance `id`'s idle teardown backstop (Teardown backstops). Called
  /// on every activity (inbound bridge message or any command); cancels instead
  /// of arming unless the instance `isHidden`. No-op if `id` has no instance.
  /// Main-thread only (Timer schedules on the current run loop, and all the
  /// plugin's UI work is main-thread).
  private func resetIdleTimer(_ id: String) {
    guard let instance = self.instances[id] else { return }
    instance.idleTimer?.invalidate()
    instance.idleTimer = nil
    guard instance.isHidden else { return }
    instance.idleTimer = Timer.scheduledTimer(
      withTimeInterval: NativeWebviewPlugin.idleTeardownSeconds,
      repeats: false
    ) { [weak self] _ in
      guard let self = self, let instance = self.instances[id], let controller = instance.controller,
        !instance.isVisible
      else { return }
      // Idle past the backstop — auto-dispose this instance, arming the race
      // guard for symmetry with a host `dispose`. See Teardown backstops.
      instance.isDisposing = true
      controller.requestDispose(wasVisible: false)
    }
  }

  /// Cancel `instance`'s idle teardown backstop (instance shown or disposed).
  private func cancelIdleTimer(_ instance: NativeWebviewInstance) {
    instance.idleTimer?.invalidate()
    instance.idleTimer = nil
  }

  /// Evaluate JS inside the current native webview. Rejects if no native webview
  /// exists (caller should `await invoke('plugin:native-webview|open_url', …)`
  /// first). The evaluation itself is asynchronous and best-effort — its return
  /// value and any thrown JS error are not surfaced.
  @objc public func evaluateJs(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EvaluateJsArgs.self)
    DispatchQueue.main.async {
      let id = args.id
      self.resetIdleTimer(id)  // a command counts as activity
      guard let instance = self.instances[id], let webView = instance.webView else {
        invoke.reject("native-webview: no native webview open")
        return
      }
      webView.evaluateJavaScript(args.script, completionHandler: nil)
      invoke.resolve(["wasDispatched": true])
    }
  }

  /// Update one or more of the native webview chrome's three labels
  /// (`title`, `subtitle`, `message`). Each field is independently
  /// optional: `nil` / absent = leave unchanged; empty string clears.
  /// Resolves with `{set: true}` once applied; `{set: false}` (not a
  /// reject) when no native webview is open, so callers can push speculatively
  /// across the native webview's lifecycle without retry plumbing.
  @objc public func patchWindowText(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PatchWindowTextArgs.self)
    DispatchQueue.main.async {
      guard let instance = self.instances[args.id], let controller = instance.controller else {
        invoke.resolve(["set": false])
        return
      }
      // Per-field: `nil` = leave unchanged; any present value (including `""`)
      // *claims* that slot. See Chrome URL-fallback.
      controller.applyWindowText(title: args.title, subtitle: args.subtitle, message: args.message)
      invoke.resolve(["set": true])
    }
  }

  /// React to the instance being removed from view while kept alive — shared by
  /// a USER dismissal and a host `hide()`. Marks it hidden, emits `hidden` on
  /// the latest channel, and arms the idle backstop. Tears nothing down. See
  /// "User dismissal hides; only `dispose` tears down".
  private func handleHidden(id: String) {
    guard let instance = self.instances[id], instance.controller != nil else { return }
    // A user swipe can fire `presentationControllerDidDismiss` *during* a
    // `dispose()` whose own dismiss is still animating. Ignore it while
    // disposing: otherwise we'd emit a spurious `hidden` and re-arm the idle
    // timer `dispose` just cancelled, both ahead of the `disposed` that
    // `handleDisposed(id:)` emits. Mirrors Android's `show()`-guards-on-`isDisposing`
    // posture. See "The dispose→open \"switch-demo\" race".
    guard !instance.isDisposing else { return }
    instance.isVisible = false
    if self.visibleId == id { self.visibleId = nil }
    // Lowercase tag matches `models.rs`; `JsonObject` pins the non-throwing send overload.
    let data: JsonObject = ["event": "hidden"]
    instance.bridge?.channel.send(data)
    self.resetIdleTimer(id)  // now hidden — start the idle backstop counting down
  }

  /// React to the instance being torn down — shared by a host `dispose()`, the
  /// idle backstop, and natural teardown (controller deinit). Frees captured
  /// state and, unless a switch-demo replay was queued, emits `disposed`. See
  /// "The dispose→open \"switch-demo\" race".
  private func handleDisposed(id: String) {
    guard let instance = self.instances[id] else { return }
    self.cancelIdleTimer(instance)
    // Read the latest (possibly re-wired) channel BEFORE clearing the bridge so
    // the `disposed` echo follows a fresh `openUrl`'s channel to the most recent
    // caller (matches desktop's `CurrentChannel` handling). See Re-open rewire.
    let disposeChannel = instance.bridge?.channel
    instance.webView = nil
    instance.controller = nil
    instance.bridge = nil
    instance.navigation = nil
    instance.isVisible = false
    instance.isDisposing = false
    if self.visibleId == id { self.visibleId = nil }
    // If a switch-demo replay was queued, run it and suppress the `disposed`
    // echo; otherwise emit `disposed`. See "The dispose→open \"switch-demo\" race".
    if let pending = instance.onDisposeFinishedHandler {
      instance.onDisposeFinishedHandler = nil
      instance.pendingInvoke = nil
      // The replay's `present(id:…)` overwrites `instances[id]` with a fresh
      // instance, so leave the (now-cleared) entry in place for it to replace.
      pending()
    } else {
      // Terminal teardown for this id: drop the entry so a later `openUrl` builds
      // fresh, then emit `disposed`. Lowercase tag matches `models.rs`;
      // `JsonObject` pins the non-throwing send overload.
      self.instances[id] = nil
      let data: JsonObject = ["event": "disposed"]
      disposeChannel?.send(data)
    }
  }

  private func present(
    id: String,
    url: URL,
    initScript: String?,
    channel: Channel,
    initialTitle: String?,
    initialSubtitle: String?,
    initialMessage: String?,
    cookies: [CookieArg]?
  ) {
    // Fresh per-id instance; overwrites any prior (torn-down) entry for this id.
    let instance = NativeWebviewInstance()
    self.instances[id] = instance

    let contentController = WKUserContentController()
    // Caller-supplied document-start script, injected into all frames on ANY
    // origin. The plugin is content-agnostic — no script means no injection.
    if let initScript = initScript {
      contentController.addUserScript(
        WKUserScript(
          source: initScript,
          injectionTime: .atDocumentStart,
          forMainFrameOnly: false
        )
      )
    }
    let bridge = NativeWebviewMessageBridge(channel: channel)
    contentController.add(bridge, name: NativeWebviewPlugin.messageHandlerName)
    instance.bridge = bridge
    bridge.onActivity = { [weak self] in self?.resetIdleTimer(id) }  // inbound traffic is activity

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = contentController

    let webView = WKWebView(frame: .zero, configuration: configuration)
    // Seed cookies first, then load — the seed must ride the first request
    // (see `seedCookies`). With no cookies this loads immediately.
    NativeWebviewPlugin.seedCookies(cookies, into: webView) {
      webView.load(URLRequest(url: url))
    }
    instance.webView = webView

    let browser = NativeWebviewController(webView: webView, initialUrl: url.absoluteString)
    instance.controller = browser
    // Apply initial chrome before presentation so the bar is correct on first
    // paint (nil = leave unchanged). See Chrome URL-fallback.
    browser.applyWindowText(
      title: initialTitle,
      subtitle: initialSubtitle,
      message: initialMessage
    )
    // User dismissal HIDES (keeps alive); only dispose tears down. See "User
    // dismissal hides; only `dispose` tears down".
    browser.onUserDismiss = { [weak self] in
      self?.handleHidden(id: id)
    }
    browser.onDispose = { [weak self] in
      self?.handleDisposed(id: id)
    }

    let navigation = UINavigationController(rootViewController: browser)
    navigation.modalPresentationStyle = .pageSheet
    // iOS: a `.pageSheet`'s interactive swipe-to-dismiss bypasses the Close
    // button, so register the controller as the sheet's presentation delegate to
    // catch the swipe and route it through the same HIDE path (see
    // `presentationControllerDidDismiss`).
    navigation.presentationController?.delegate = browser
    // Theme the native chrome to the app palette, tracking the OS appearance.
    let barAppearance = UINavigationBarAppearance()
    barAppearance.configureWithOpaqueBackground()
    barAppearance.backgroundColor = WildflowerColor.colorBackground
    barAppearance.titleTextAttributes = [.foregroundColor: WildflowerColor.colorNeutral1]
    navigation.navigationBar.standardAppearance = barAppearance
    navigation.navigationBar.scrollEdgeAppearance = barAppearance
    navigation.navigationBar.tintColor = WildflowerColor.colorNeutral1

    let toolbarAppearance = UIToolbarAppearance()
    toolbarAppearance.configureWithOpaqueBackground()
    toolbarAppearance.backgroundColor = WildflowerColor.colorBackground
    navigation.toolbar.standardAppearance = toolbarAppearance
    if #available(iOS 15.0, *) {
      navigation.toolbar.scrollEdgeAppearance = toolbarAppearance
    }
    navigation.toolbar.tintColor = WildflowerColor.colorNeutral1
    // Show the bottom toolbar so the controller's back/forward `toolbarItems`
    // render. The view controller also flips this on appear; doing it here too
    // avoids a flash at open.
    navigation.isToolbarHidden = false
    // Build HIDDEN — do NOT present here (`show` does that later).
    instance.navigation = navigation
    instance.isVisible = false
    // Arm the idle backstop so a built-but-never-shown instance is reclaimed.
    resetIdleTimer(id)
  }

  /// The top-most presented view controller to present the native webview from.
  private func topViewController() -> UIViewController? {
    let keyWindow = UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.windows.first(where: { $0.isKeyWindow }) }
      .first
    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

/// App palette as dynamic colors that resolve per the OS light/dark
/// appearance. Same tokens as the web app's `--color-background` /
/// `--color-neutral-1` / `--color-neutral-4` (named to match for clear
/// relatedness); redefined here because the native chrome can't read the web
/// app's CSS.
enum WildflowerColor {
  static let colorBackground = dynamic(light: 0xF7_EC_DD, dark: 0x22_1B_16)
  static let colorNeutral1 = dynamic(light: 0x2C_21_1D, dark: 0xF3_E9_DB)
  static let colorNeutral4 = dynamic(light: 0x6C_5B_50, dark: 0xB3_A2_94)

  /// A `UIColor` that picks `light` or `dark` (each an `0xRRGGBB` literal) from
  /// the resolving trait collection, so it tracks the OS appearance live.
  private static func dynamic(light: Int, dark: Int) -> UIColor {
    UIColor { traits in rgb(traits.userInterfaceStyle == .dark ? dark : light) }
  }

  private static func rgb(_ hex: Int) -> UIColor {
    UIColor(
      red: CGFloat((hex >> 16) & 0xFF) / 255.0,
      green: CGFloat((hex >> 8) & 0xFF) / 255.0,
      blue: CGFloat(hex & 0xFF) / 255.0,
      alpha: 1.0
    )
  }
}

/// Two-line title view stacked vertically in the navigation bar: the page
/// host on top (semibold), a caller-controlled status subtitle beneath
/// (smaller, secondary colour). Used as `navigationItem.titleView` so the
/// chrome matches across iOS versions (`UINavigationItem.subtitle` is
/// iOS 16+ only).
class WebViewTitleView: UIView {
  let titleLabel = UILabel()
  let subtitleLabel = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
    titleLabel.textAlignment = .center
    titleLabel.textColor = WildflowerColor.colorNeutral1
    // The title slot can hold the full URL (Chrome URL-fallback), so truncate
    // from the tail to keep the more-identifying scheme + host visible.
    titleLabel.lineBreakMode = .byTruncatingTail

    subtitleLabel.font = .systemFont(ofSize: 11, weight: .regular)
    subtitleLabel.textAlignment = .center
    subtitleLabel.textColor = WildflowerColor.colorNeutral4
    subtitleLabel.lineBreakMode = .byTruncatingTail
    subtitleLabel.isHidden = true

    let stack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
    stack.axis = .vertical
    stack.alignment = .center
    stack.distribution = .equalSpacing
    stack.spacing = 0
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  /// Set or clear the subtitle. `nil` / empty hides the row so the title
  /// centres vertically (avoiding an empty gap beneath the host).
  func setSubtitle(_ subtitle: String?) {
    if let subtitle = subtitle, !subtitle.isEmpty {
      subtitleLabel.text = subtitle
      subtitleLabel.isHidden = false
    } else {
      subtitleLabel.text = nil
      subtitleLabel.isHidden = true
    }
  }
}

/// Hosts the native webview's `WKWebView` with native chrome:
///
/// - Left bar item: Close (dismisses the sheet, fires `onUserDismiss` → HIDE).
/// - Right bar item: Refresh (`webView.reload()`).
/// - Title view: `WebViewTitleView` — title + subtitle slots; the page URL fills
///   the highest unclaimed slot, kept in sync by `url`-KVO. See Chrome
///   URL-fallback (and `applyWindowText` / `renderUrlFallback`).
/// - Bottom toolbar: Back / Forward (KVO-driven enabled state), then a
///   caller-controlled `message` label for status text.
class NativeWebviewController: UIViewController, UIAdaptivePresentationControllerDelegate {
  private let webView: WKWebView
  private var canGoBackObservation: NSKeyValueObservation?
  private var canGoForwardObservation: NSKeyValueObservation?
  private var urlObservation: NSKeyValueObservation?
  private let titleView = WebViewTitleView()
  private let messageLabel = UILabel()
  private lazy var messageItem = UIBarButtonItem(customView: messageLabel)
  private lazy var backItem = UIBarButtonItem(
    image: UIImage(systemName: "chevron.backward"),
    style: .plain,
    target: self,
    action: #selector(goBackTapped)
  )
  private lazy var forwardItem = UIBarButtonItem(
    image: UIImage(systemName: "chevron.forward"),
    style: .plain,
    target: self,
    action: #selector(goForwardTapped)
  )

  /// Called on a USER dismissal (Close button or swipe-to-dismiss) → the plugin
  /// HIDES. See "User dismissal hides; only `dispose` tears down".
  var onUserDismiss: (() -> Void)?

  /// Called on teardown — a host `dispose()`, the idle backstop, or natural
  /// teardown (`deinit`) → the plugin frees state and emits `disposed`.
  var onDispose: (() -> Void)?

  /// Guards against a double `onDispose` between `requestDispose` and `deinit`:
  /// set once disposed so the `deinit` backstop stays silent (a normal hide
  /// leaves it `false`, so a later deallocation still emits `disposed`).
  private var didDispose = false

  /// Chrome URL-fallback state. `url` is the live page URL painted into the
  /// highest unclaimed slot; `titleClaimed` / `subtitleClaimed` record caller
  /// claims. See Chrome URL-fallback in docs/Lifecycle and Races Explanation.md.
  private var url: String
  private var titleClaimed = false
  private var subtitleClaimed = false

  init(webView: WKWebView, initialUrl: String) {
    self.webView = webView
    self.url = initialUrl
    super.init(nibName: nil, bundle: nil)
    navigationItem.titleView = titleView
    messageLabel.font = .systemFont(ofSize: 13, weight: .regular)
    messageLabel.textColor = WildflowerColor.colorNeutral4
    messageLabel.lineBreakMode = .byTruncatingTail
    // Paint the URL into the title slot before the caller claims anything.
    renderUrlFallback()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func loadView() {
    view = webView
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    navigationItem.leftBarButtonItem = UIBarButtonItem(
      barButtonSystemItem: .close,
      target: self,
      action: #selector(closeTapped)
    )
    navigationItem.rightBarButtonItem = UIBarButtonItem(
      barButtonSystemItem: .refresh,
      target: self,
      action: #selector(refreshTapped)
    )

    // Bottom toolbar layout (leading → trailing):
    //   [back] [forward] [flexible]            (no message)
    //   [back] [forward] [flexible] [message]  (with message)
    // The flexible spacer absorbs the remaining width so the message label
    // sits at the trailing edge. The empty-message layout omits the
    // messageItem entirely — an empty custom UILabel still renders as a
    // 0-width baseline dot in a UIToolbar, which looks like garbage.
    // `rebuildToolbarItems` is the single writer for this array.
    rebuildToolbarItems()
    backItem.isEnabled = webView.canGoBack
    forwardItem.isEnabled = webView.canGoForward

    // Observe the nav-arrow enabled state and the page URL; the `url`
    // observation feeds `onNavigate` → Chrome URL-fallback re-render.
    canGoBackObservation = webView.observe(\.canGoBack, options: [.new]) { [weak self] webView, _ in
      self?.backItem.isEnabled = webView.canGoBack
    }
    canGoForwardObservation = webView.observe(\.canGoForward, options: [.new]) {
      [weak self] webView, _ in
      self?.forwardItem.isEnabled = webView.canGoForward
    }
    urlObservation = webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
      guard let url = webView.url?.absoluteString else { return }
      self?.onNavigate(url)
    }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    // Reveal the toolbar (hidden by default on a fresh UINavigationController) so
    // the back/forward items render. Idempotent with the same call in `present`.
    navigationController?.setToolbarHidden(false, animated: false)
  }

  @objc private func goBackTapped() {
    webView.goBack()
  }

  @objc private func goForwardTapped() {
    webView.goForward()
  }

  @objc private func refreshTapped() {
    webView.reload()
  }

  @objc private func closeTapped() {
    // The Close button is a USER dismissal → HIDE. Fire `onUserDismiss` from the
    // dismiss completion. See "User dismissal hides; only `dispose` tears down".
    dismiss(animated: true) { [weak self] in
      self?.onUserDismiss?()
    }
  }

  /// Tear the instance down — for a host `dispose()` and the idle backstop. When
  /// on screen (`wasVisible`), animate it away first and fire `onDispose` from
  /// the dismiss completion; when already hidden, fire it directly. Marks
  /// `didDispose` so the `deinit` backstop stays silent.
  func requestDispose(wasVisible: Bool) {
    didDispose = true
    if wasVisible {
      dismiss(animated: true) { [weak self] in
        self?.onDispose?()
      }
    } else {
      onDispose?()
    }
  }

  /// Interactive swipe-to-dismiss bypasses the Close button, so UIKit reports it
  /// here instead — a USER dismissal routed through the same `onUserDismiss`
  /// (HIDE) path. iOS quirk relied on by the doc: UIKit does NOT call this for a
  /// programmatic `dismiss(animated:)`, so the button / `hide` / `dispose` paths
  /// (which fire from their own dismiss completions) never double-emit with the
  /// swipe. See "User dismissal hides; only `dispose` tears down".
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    onUserDismiss?()
  }

  /// Apply caller-supplied window text in one call — `nil` = leave unchanged;
  /// any present value (including `""`) *claims* that slot. Shared by `openUrl`'s
  /// initial chrome, `patchWindowText`, and reopen; records claims then re-renders
  /// the URL fallback. See Chrome URL-fallback.
  func applyWindowText(title: String?, subtitle: String?, message: String?) {
    if let title = title {
      titleClaimed = true
      updateTitle(title)
    }
    if let subtitle = subtitle {
      subtitleClaimed = true
      updateSubtitle(subtitle)
    }
    if let message = message { updateMessage(message) }
    renderUrlFallback()
  }

  /// Paint the current page `url` into the highest unclaimed slot (title, then
  /// subtitle, then nowhere); claimed slots are never overwritten. See Chrome
  /// URL-fallback.
  private func renderUrlFallback() {
    if !titleClaimed {
      updateTitle(url)
    } else if !subtitleClaimed {
      updateSubtitle(url)
    }
  }

  /// Sync the URL fallback to a navigation (driven by `url`-KVO).
  func onNavigate(_ newUrl: String) {
    url = newUrl
    renderUrlFallback()
  }

  /// Reset claim state for a Re-open rewire: both slots unclaimed (URL back in
  /// the title), blank message, then re-apply the caller's initial chrome — so a
  /// reused instance is indistinguishable from a fresh build. See Re-open rewire.
  func reopen(url newUrl: String, title: String?, subtitle: String?, message: String?) {
    url = newUrl
    titleClaimed = false
    subtitleClaimed = false
    updateMessage("")
    applyWindowText(title: title, subtitle: subtitle, message: message)
  }

  /// Write the title slot directly (no claim bookkeeping). Empty string clears.
  func updateTitle(_ title: String) {
    titleView.titleLabel.text = title.isEmpty ? nil : title
  }

  /// Write the subtitle slot directly (no claim bookkeeping). Empty string
  /// clears (hiding the row).
  func updateSubtitle(_ subtitle: String) {
    titleView.setSubtitle(subtitle.isEmpty ? nil : subtitle)
  }

  /// Push a new bottom-bar message. Called from the plugin's `patchWindowText`
  /// command on the main thread. Empty string clears. The label's intrinsic
  /// size resizes in place inside its `customView`, so the toolbar is only
  /// rebuilt when the message's *presence* toggles (empty ⇄ non-empty) — the
  /// slot appears or disappears then. The common case for status text (e.g.
  /// "34 resources collected" → "35 resources collected") is non-empty →
  /// non-empty, which just updates the label and skips a full `UIToolbar`
  /// relayout the frequent sniffer pushes would otherwise force every tick.
  func updateMessage(_ message: String) {
    let hadMessage = !(messageLabel.text?.isEmpty ?? true)
    messageLabel.text = message.isEmpty ? nil : message
    messageLabel.sizeToFit()
    let hasMessage = !message.isEmpty
    if hadMessage != hasMessage {
      rebuildToolbarItems()
    }
  }

  /// (Re)compose `toolbarItems` from the current `messageLabel.text` — the
  /// single writer for `toolbarItems`, including the message slot only when
  /// there's text to render (see the layout note in `viewDidLoad`).
  private func rebuildToolbarItems() {
    let flexible = UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
    let hasMessage = !(messageLabel.text?.isEmpty ?? true)
    if hasMessage {
      toolbarItems = [backItem, forwardItem, flexible, messageItem]
    } else {
      toolbarItems = [backItem, forwardItem, flexible]
    }
  }

  deinit {
    canGoBackObservation?.invalidate()
    canGoForwardObservation?.invalidate()
    urlObservation?.invalidate()
    // Natural-teardown backstop: deallocated without an explicit `dispose`
    // (which would have set `didDispose`) — emit `disposed` so the host still
    // sees a terminal event. See Teardown backstops.
    if !didDispose {
      onDispose?()
    }
    // iOS: `WKUserContentController` retains its script-message handlers
    // strongly; drop ours so the bridge (and the webview graph behind it) can
    // deallocate (see `NativeWebviewMessageBridge`'s retain note).
    webView.configuration.userContentController.removeScriptMessageHandler(
      forName: NativeWebviewPlugin.messageHandlerName
    )
  }
}

/// Entry point Tauri's `ios_plugin_binding!(init_plugin_native_webview)` links
/// against; returns the plugin instance Tauri drives.
@_cdecl("init_plugin_native_webview")
func initPlugin() -> Plugin {
  return NativeWebviewPlugin()
}
