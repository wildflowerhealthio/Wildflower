import Tauri
import UIKit
import WebKit

/// Arguments decoded from `invoke('plugin:native-webview|open_url', { url, initScript, nativeWebviewEventChannel })`.
/// Keys match `OpenRequest`'s camelCase serde wire shape; `initScript` is
/// omitted when absent. `nativeWebviewEventChannel` is a Tauri `Channel<NativeWebviewEvent>`
/// the caller receives native webview events on (`{"event":"message", "payload": …}` /
/// `{"event":"hidden"}` / `{"event":"disposed"}`) — see `models.rs` `NativeWebviewEvent`.
class OpenArgs: Decodable {
  let url: String
  let initScript: String?
  let nativeWebviewEventChannel: Channel
  // Chrome applied at presentation time (omitted keys decode to nil — leave
  // unchanged). Matches `OpenRequest`'s `initialTitle` / `initialSubtitle` /
  // `initialMessage` camelCase wire shape.
  let initialTitle: String?
  let initialSubtitle: String?
  let initialMessage: String?
}

/// Arguments decoded from `invoke('plugin:native-webview|evaluate_js', { script })`.
/// Keys match `EvaluateJsRequest`'s camelCase serde wire shape. The host evaluates
/// `script` verbatim in the native webview — typically a
/// `window.__nativeWebviewReceive(JSON.stringify(...))` call carrying a bridge
/// envelope.
class EvaluateJsArgs: Decodable {
  let script: String
}

/// Arguments decoded from `invoke('plugin:native-webview|patch_window_text', { title?, subtitle?, message? })`.
/// Keys match `PatchWindowTextRequest`'s camelCase serde wire shape. Each field is
/// optional: `nil` / absent means "leave unchanged"; empty string clears that
/// label. The plugin batches all three to keep multi-field updates flicker-free.
class PatchWindowTextArgs: Decodable {
  let title: String?
  let subtitle: String?
  let message: String?
}

/// Per-native-webview script message handler: holds the caller's [`Channel`] and
/// forwards each `window.webkit.messageHandlers.nativeWebview.postMessage(...)`
/// call as a `NativeWebviewEvent.message` payload. Per-native-webview (rather than plugin-
/// singleton) so a stacked second `openUrl` doesn't redirect the first native webview's
/// events into the second native webview's channel.
///
/// `channel` is `var` so a second `openUrl()` against an existing native webview can
/// rebind it without rebuilding the webview — see `NativeWebviewPlugin.openUrl`'s
/// re-wire branch.
///
/// `onActivity` is invoked for every inbound message so the plugin can reset its
/// hidden-idle teardown backstop — any inbound bridge traffic counts as activity
/// (see `NativeWebviewPlugin.resetIdleTimer`).
///
/// `WKUserContentController` retains its script-message handlers strongly, and
/// a native webview's `userContentController.add(handler, name: ...)` then retains the
/// handler back through the webview's configuration — the chain that
/// historically required the `WeakScriptMessageHandler` indirection. We sidestep
/// the cycle by removing this handler in the native webview controller's `deinit`.
class NativeWebviewMessageBridge: NSObject, WKScriptMessageHandler {
  var channel: Channel
  /// Called on every inbound message so the plugin resets its hidden-idle
  /// teardown backstop. Weak-captures the plugin at the callsite to avoid a
  /// retain cycle (the plugin owns the webview graph that retains this bridge).
  var onActivity: (() -> Void)?

  init(channel: Channel) {
    self.channel = channel
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    // The injected adapter posts an opaque JSON string (the sniffer's wire
    // message). Forward it verbatim through the caller's channel as a
    // `NativeWebviewEvent.message` (matches `models.rs` `NativeWebviewEvent` serde shape).
    // The explicit `JsonObject` annotation pins the non-throwing
    // `send(JsonObject)` overload — without it, Swift infers `[String: String]`
    // and picks the throwing `send<T: Encodable>` generic.
    guard message.name == NativeWebviewPlugin.messageHandlerName,
      let payload = message.body as? String
    else { return }

    // Inbound bridge traffic is activity — push back the hidden-idle teardown.
    onActivity?()
    let data: JsonObject = ["event": "message", "payload": payload]
    channel.send(data)
  }
}

/// Native web view plugin.
///
/// `openUrl` ensures a `WKWebView` (inside a `UINavigationController` with a
/// native Close button + the page URL as the title, until the caller claims it)
/// exists — building it HIDDEN if absent — and navigates it to the requested
/// URL. It does NOT present; `show` presents the (possibly previously-hidden)
/// instance as a page sheet. A document-start `WKUserScript` is injected into
/// every page on every origin, and each ping it posts back is forwarded to the
/// Rust caller through the per-native-webview [`Channel`] passed in `OpenArgs`
/// (no JS-side bridge).
///
/// Lifecycle: a USER dismissal (Close button or interactive sheet swipe) HIDES
/// the instance (keeps it alive + running) and emits `hidden`; only an explicit
/// `dispose` (or the teardown backstop) tears the webview down and emits
/// `disposed`. While hidden, a 5-minute idle timer auto-`dispose`s if nothing
/// resets it — see `resetIdleTimer`.
class NativeWebviewPlugin: Plugin {
  /// `window.webkit.messageHandlers.<name>` the injected script posts to.
  static let messageHandlerName = "nativeWebview"

  /// Hidden-idle teardown backstop: while the native webview is hidden, dispose
  /// it if this many seconds pass with no activity (no inbound bridge message,
  /// no command). Any activity resets the timer (see `resetIdleTimer`).
  static let idleTeardownSeconds: TimeInterval = 5 * 60

  /// The current native webview, if any. Captured on `openUrl` so `evaluateJs`
  /// can `evaluateJavaScript(...)` into it; held STRONGLY so a hidden (dismissed
  /// but not disposed) instance stays alive and running until an explicit
  /// `dispose`. Cleared in `teardown()` (the only path that frees it) so
  /// `evaluateJs` then fails loudly with a "no native webview open" reject.
  private var currentWebView: WKWebView?

  /// The current native webview controller, if any. Captured on `openUrl` so
  /// `applyWindowText` / `patchWindowText` can update its chrome labels, and so
  /// `show` / `hide` can present / dismiss it. Held strongly for the same
  /// keep-alive-while-hidden rationale as `currentWebView`.
  private var currentController: NativeWebviewController?

  /// The current native webview's message bridge. Captured on `openUrl` so a
  /// subsequent `openUrl()` against an existing native webview can re-bind its
  /// `channel` without rebuilding the webview (re-wire). Held strongly for the
  /// same keep-alive-while-hidden rationale.
  private var currentBridge: NativeWebviewMessageBridge?

  /// The `UINavigationController` wrapping `currentController`, retained so
  /// `show` can re-present a previously-hidden instance and `hide` can dismiss
  /// it without tearing it down. The webview graph lives under this controller.
  private var currentNavigation: UINavigationController?

  /// Whether the current native webview is presently on screen. `openUrl`
  /// preserves it (navigates in place); `show` sets it true, a user dismissal
  /// and `hide` set it false. Tracked explicitly because a hidden instance is
  /// kept alive, so "exists" and "is visible" are independent.
  private var isVisible = false

  /// Set when a same-tick `openUrl()` arrives while a previous native webview is
  /// in its `dispose` teardown dismiss animation (`controller.isBeingDismissed`
  /// during a dispose). The pending closure runs from `onDisposed` once the
  /// animation completes, presenting a fresh native webview. When set,
  /// `onDisposed` suppresses the `disposed` channel echo — the caller logically
  /// continues with new wiring rather than firing a spurious teardown
  /// (dispose→openUrl switch-demo race guard). A user-dismissal HIDE never arms
  /// this (hide keeps the instance alive, so a following `openUrl` navigates in
  /// place).
  private var onDisposeFinishedHandler: (() -> Void)?

  /// The `Invoke` whose `resolve` is owned by [`onDisposeFinishedHandler`]. Held
  /// separately so that if a *second* `openUrl()` supersedes a still-queued one
  /// (both during the same dispose animation), the superseded invoke can be
  /// rejected before its closure is overwritten — otherwise its JS promise
  /// would hang forever (there's no timeout on `openUrl`).
  private var pendingInvoke: Invoke?

  /// Set between a `dispose` (host command or idle backstop) and the
  /// `handleDisposed` that completes its teardown. Distinguishes a dispose
  /// teardown animation from a `hide` dismiss animation: a same-tick `openUrl`
  /// queues a replay only when `isDisposing` is set (the instance is going
  /// away), and rewires in place otherwise (a hide keeps the instance alive).
  /// Without this, a `hide` + same-tick `openUrl` would wrongly queue a replay
  /// onto `onDisposeFinishedHandler` that nothing ever runs (hide lands in
  /// `handleHidden`, not `handleDisposed`), hanging the invoke.
  private var isDisposing = false

  /// Hidden-idle teardown timer. Armed by `hide` / a user dismissal (the only
  /// states where an idle instance should be reclaimed), reset by any activity
  /// (inbound bridge message or any command via `resetIdleTimer`), and
  /// cancelled when the instance is shown or disposed. Fires on the main run
  /// loop; the plugin's UI work is all main-thread.
  private var idleTimer: Timer?

  /// Ensure a native webview exists and navigate it to `url`. Builds the
  /// webview HIDDEN if absent; on an existing instance, re-wires (channel /
  /// initScript / chrome) and navigates in place, PRESERVING current visibility.
  /// Never presents — call `show` to bring it to the foreground. Resolves with
  /// `{opened: true}`. (Renamed from the former `open`.)
  @objc public func openUrl(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("native-webview: invalid URL \(args.url)")
      return
    }

    DispatchQueue.main.async {
      // Any command is activity — push back the hidden-idle teardown backstop.
      self.resetIdleTimer()
      // Dispose teardown in flight (a host `dispose()` whose dismiss animation
      // hasn't completed): queue a replay for when the controller finishes
      // tearing down, then present a fresh instance. `onDisposed` consumes the
      // pending closure and suppresses the `disposed` echo so the caller
      // logically continues with new wiring (dispose→openUrl switch-demo race
      // guard). Last-write-wins on rapid repeats. A user-dismissal HIDE keeps
      // the instance alive, so `isDisposing` stays false and it never reaches
      // this branch — it falls through to the re-wire branch below and navigates
      // in place even mid-hide-animation.
      if self.isDisposing {
        // Supersede any already-queued openUrl: settle its promise so a caller
        // doing two quick `openUrl()`s during the dispose animation doesn't get
        // a permanently-hung `await` for the first one (last-write-wins would
        // otherwise drop its `resolve`).
        self.pendingInvoke?.reject(
          "native-webview: superseded by a newer open() before the popup finished closing")
        self.pendingInvoke = invoke
        self.onDisposeFinishedHandler = { [weak self] in
          guard let self = self else { return }
          self.present(
            url: url,
            initScript: args.initScript,
            channel: args.nativeWebviewEventChannel,
            initialTitle: args.initialTitle,
            initialSubtitle: args.initialSubtitle,
            initialMessage: args.initialMessage
          )
          invoke.resolve(["opened": true])
        }
        return
      }
      // Existing instance (visible OR hidden) and not being torn down: re-wire
      // it in place, PRESERVING its current visibility (do NOT present here).
      // Channel rebinds via `bridge.channel = …`; the new `initScript` is
      // `eval`'d into the current page (NOT document-start for the just-loaded
      // one — caveat documented in `desktop.rs`) and also added to the user
      // content controller so future loads inside this native webview run it at
      // document-start. `reopen` resets the URL-fallback claim state so the
      // reused native webview starts fresh (URL back in the title), then
      // re-applies the caller's initial chrome.
      if let existing = self.currentWebView, let bridge = self.currentBridge {
        bridge.channel = args.nativeWebviewEventChannel
        if let initScript = args.initScript {
          existing.evaluateJavaScript(initScript, completionHandler: nil)
          // Drop the prior document-start script before re-adding so repeated
          // re-wires don't stack N copies — otherwise every later page load in
          // this native webview would run the caller's init IIFE N+1 times (the
          // sniffer's installSniffer would double-hook fetch/XHR). The plugin
          // adds exactly one user script (the initScript), so clearing all is
          // safe.
          existing.configuration.userContentController.removeAllUserScripts()
          existing.configuration.userContentController.addUserScript(
            WKUserScript(
              source: initScript,
              injectionTime: .atDocumentStart,
              forMainFrameOnly: false
            )
          )
        }
        self.currentController?.reopen(
          url: url.absoluteString,
          title: args.initialTitle,
          subtitle: args.initialSubtitle,
          message: args.initialMessage
        )
        existing.load(URLRequest(url: url))
        invoke.resolve(["opened": true])
        return
      }
      // No instance: build one HIDDEN (navigation and presentation are separate
      // concerns — a background navigation never steals focus). `present`
      // constructs the webview graph but does not call UIKit `present(_:)`.
      self.present(
        url: url,
        initScript: args.initScript,
        channel: args.nativeWebviewEventChannel,
        initialTitle: args.initialTitle,
        initialSubtitle: args.initialSubtitle,
        initialMessage: args.initialMessage
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
    DispatchQueue.main.async {
      self.cancelIdleTimer()
      // A dispose teardown is in flight (its dismiss animation hasn't completed
      // and `handleDisposed` will free the controller / WKWebView). Presenting
      // now races UIKit's "present while dismissal in progress" no-op while
      // flipping `isVisible` true on a doomed instance — a shown-but-invisible
      // desync. Mirror `openUrl`'s `isDisposing` guard: nothing presentable.
      if self.isDisposing {
        invoke.resolve(["requestCausedShow": false])
        return
      }
      guard let navigation = self.currentNavigation else {
        invoke.resolve(["requestCausedShow": false])
        return
      }
      if self.isVisible {
        // Already on screen — `show` is idempotent, but no transition was
        // caused, so report `false`.
        invoke.resolve(["requestCausedShow": false])
        return
      }
      self.isVisible = true
      self.topViewController()?.present(navigation, animated: true)
      invoke.resolve(["requestCausedShow": true])
    }
  }

  /// Hide the native webview — remove it from view but keep it alive and
  /// running (do NOT tear it down). Emits `NativeWebviewEvent.hidden` on the
  /// channel and arms the hidden-idle teardown backstop. Resolves with
  /// `{requestCausedHide: false}` when nothing was visible, `{requestCausedHide:
  /// true}` once hidden.
  @objc public func hide(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      self.resetIdleTimer()
      guard self.isVisible, let navigation = self.currentNavigation else {
        invoke.resolve(["requestCausedHide": false])
        return
      }
      // A host `hide()` lands in the same `handleHidden()` a user dismissal
      // uses, so the `hidden` echo + idle-timer arming happen in exactly one
      // place. UIKit does NOT call `presentationControllerDidDismiss` for a
      // programmatic `dismiss(animated:)`, so `handleHidden` is invoked from the
      // dismiss completion here (the swipe path calls it from the delegate),
      // never double-fired.
      navigation.dismiss(animated: true) { [weak self] in
        self?.handleHidden()
      }
      invoke.resolve(["requestCausedHide": true])
    }
  }

  /// Dispose the native webview — tear it down and free its resources (the
  /// controller / WKWebView / bridge). Emits `NativeWebviewEvent.disposed` on
  /// the channel and cancels the idle timer. Resolves with
  /// `{requestCausedDispose: false}` when none existed, `{requestCausedDispose:
  /// true}` once torn down. Routes through the controller's `requestDispose()` so
  /// a same-tick `openUrl` lands in the deferral branch of `openUrl` rather than
  /// re-wiring a doomed webview.
  @objc public func dispose(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      self.cancelIdleTimer()
      guard let controller = self.currentController else {
        invoke.resolve(["requestCausedDispose": false])
        return
      }
      // Arm the race guard so a same-tick `openUrl` queues a replay rather than
      // re-wiring the doomed webview. Cleared in `handleDisposed`.
      self.isDisposing = true
      controller.requestDispose(wasVisible: self.isVisible)
      invoke.resolve(["requestCausedDispose": true])
    }
  }

  /// (Re)arm the hidden-idle teardown backstop to fire `idleTeardownSeconds`
  /// from now. Called on every activity — any inbound bridge message (via the
  /// bridge's `onActivity`) and every command. The timer only runs while the
  /// instance is HIDDEN (exists but not visible): when there's no instance, or
  /// it's currently visible, this cancels any timer instead of arming one (a
  /// visible webview is never idle-reclaimed). Main-thread only (Timer schedules
  /// on the current run loop, and all the plugin's UI work is main-thread).
  private func resetIdleTimer() {
    idleTimer?.invalidate()
    idleTimer = nil
    guard self.currentController != nil, !self.isVisible else { return }
    idleTimer = Timer.scheduledTimer(
      withTimeInterval: NativeWebviewPlugin.idleTeardownSeconds,
      repeats: false
    ) { [weak self] _ in
      guard let self = self, let controller = self.currentController, !self.isVisible
      else { return }
      // The instance has sat hidden + idle past the backstop — auto-dispose it
      // (emits `disposed`), freeing the still-live (hidden) WebView and its JS
      // thread. Arm the race guard for symmetry with a host `dispose`.
      self.isDisposing = true
      controller.requestDispose(wasVisible: false)
    }
  }

  /// Cancel the hidden-idle teardown backstop (instance shown or disposed).
  private func cancelIdleTimer() {
    idleTimer?.invalidate()
    idleTimer = nil
  }

  /// Evaluate JS inside the current native webview. Rejects if no native webview
  /// exists (caller should `await invoke('plugin:native-webview|open_url', …)`
  /// first). The evaluation itself is asynchronous and best-effort — its return
  /// value and any thrown JS error are not surfaced.
  @objc public func evaluateJs(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EvaluateJsArgs.self)
    DispatchQueue.main.async {
      // Any command is activity — push back the hidden-idle teardown backstop.
      self.resetIdleTimer()
      guard let webView = self.currentWebView else {
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
      guard let controller = self.currentController else {
        invoke.resolve(["set": false])
        return
      }
      // Patch notation per field: `nil` (key absent) = leave the label
      // unchanged; any present value (including `""`) *claims* that slot for
      // the caller, so the URL fallback stops painting it. `applyWindowText`
      // routes each through `updateTitle/Subtitle/Message` and re-renders the
      // URL into whichever slot is still unclaimed.
      controller.applyWindowText(title: args.title, subtitle: args.subtitle, message: args.message)
      invoke.resolve(["set": true])
    }
  }

  /// React to the native webview being removed from view while kept alive — the
  /// shared landing point for a USER dismissal (Close button or interactive
  /// sheet swipe) and a host `hide()`. Marks the instance hidden, emits
  /// `NativeWebviewEvent.hidden` on the latest channel, and arms the
  /// hidden-idle teardown backstop. Does NOT tear anything down.
  private func handleHidden() {
    guard self.currentController != nil else { return }
    self.isVisible = false
    // NativeWebviewEvent.hidden (lowercase tag) — matches the `models.rs` shape.
    // `JsonObject` annotation pins the non-throwing overload.
    let data: JsonObject = ["event": "hidden"]
    self.currentBridge?.channel.send(data)
    // Now that it's hidden, start the idle backstop counting down.
    self.resetIdleTimer()
  }

  /// React to the native webview being torn down — the landing point for a host
  /// `dispose()`, the hidden-idle teardown backstop, and natural teardown
  /// (controller deinit). Reads the latest (possibly re-wired) channel, frees
  /// the captured state, and — unless a same-tick `openUrl` queued a replay —
  /// emits `NativeWebviewEvent.disposed`.
  private func handleDisposed() {
    self.cancelIdleTimer()
    // Read the latest (possibly re-wired) channel BEFORE clearing the bridge so
    // the `disposed` echo follows a fresh `openUrl`'s channel to the most recent
    // caller (matches desktop's `CurrentChannel` handling).
    let disposeChannel = self.currentBridge?.channel
    self.currentWebView = nil
    self.currentController = nil
    self.currentBridge = nil
    self.currentNavigation = nil
    self.isVisible = false
    self.isDisposing = false
    // If `openUrl()` queued a replay during the dispose teardown animation, run
    // it now and skip the `disposed` echo — the caller logically continues with
    // new wiring (switch-demo race guard). Otherwise this is a real teardown;
    // emit `disposed` so the host's collector releases per-native-webview state.
    if let pending = self.onDisposeFinishedHandler {
      self.onDisposeFinishedHandler = nil
      self.pendingInvoke = nil
      pending()
    } else {
      // NativeWebviewEvent.disposed (lowercase tag) — matches the `models.rs`
      // shape. `JsonObject` annotation pins the non-throwing overload.
      let data: JsonObject = ["event": "disposed"]
      disposeChannel?.send(data)
    }
  }

  private func present(
    url: URL,
    initScript: String?,
    channel: Channel,
    initialTitle: String?,
    initialSubtitle: String?,
    initialMessage: String?
  ) {
    let contentController = WKUserContentController()
    // Caller-supplied document-start script, injected into all frames on ANY
    // origin (e.g. browser-sniffer's bundled installSniffer IIFE). The plugin
    // is content-agnostic — no script means no injection.
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
    // Capture so `openUrl()`'s re-wire branch can swap `bridge.channel` without
    // rebuilding the webview, and so `handleHidden` / `handleDisposed` can read
    // the latest channel.
    currentBridge = bridge
    // Inbound bridge traffic is activity — reset the hidden-idle teardown.
    bridge.onActivity = { [weak self] in self?.resetIdleTimer() }

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = contentController

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.load(URLRequest(url: url))
    // Capture so `evaluateJs` can target it; cleared in `handleDisposed`.
    currentWebView = webView

    let browser = NativeWebviewController(webView: webView, initialUrl: url.absoluteString)
    // Capture so `applyWindowText` can target the controller's chrome;
    // cleared in `handleDisposed` alongside `currentWebView`.
    currentController = browser
    // Apply caller-supplied initial chrome before presentation so the bar is
    // correct on first paint (nil = leave unchanged). The controller's URL
    // fallback shows the page URL in the highest slot the caller hasn't
    // claimed, so an `openUrl` with no title/subtitle still shows where the
    // native webview navigated.
    browser.applyWindowText(
      title: initialTitle,
      subtitle: initialSubtitle,
      message: initialMessage
    )
    // A USER dismissal — the Close toolbar button or an interactive sheet
    // swipe-to-dismiss — HIDES the instance (keeps it alive + running) and
    // emits `hidden`. It does NOT tear down. Both affordances land here.
    browser.onUserDismiss = { [weak self] in
      self?.handleHidden()
    }
    // An explicit `dispose` (or the idle backstop / controller deinit) tears the
    // webview down and emits `disposed`.
    browser.onDispose = { [weak self] in
      self?.handleDisposed()
    }

    let navigation = UINavigationController(rootViewController: browser)
    navigation.modalPresentationStyle = .pageSheet
    // A `.pageSheet` is interactively swipe-dismissable. That gesture does NOT
    // route through the Close button, so register the controller as the sheet's
    // presentation delegate to catch it and still HIDE + emit `hidden` (see
    // `presentationControllerDidDismiss`). Without this, a swipe-away would
    // silently leave a live-but-orphaned instance and never emit `hidden`.
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
    // Show the navigation controller's bottom toolbar so the controller's
    // `toolbarItems` (back / forward) render. The view controller hides /
    // shows it on appear, but flipping it here too avoids a flash at open.
    navigation.isToolbarHidden = false
    // Build HIDDEN: capture the navigation controller so `show` can present it
    // (and `hide` can dismiss it) without rebuilding, but do NOT present here —
    // navigation (`openUrl`) and presentation (`show`) are separate concerns.
    currentNavigation = navigation
    isVisible = false
    // The instance starts hidden; arm the idle-teardown backstop so a built-
    // but-never-shown instance is eventually reclaimed. `show` cancels it.
    resetIdleTimer()
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
    // The title slot holds the full URL until the caller claims it (see
    // `NativeWebviewController`'s URL-fallback state machine), so truncate from
    // the tail to keep the scheme + host — the most identifying part — visible;
    // the path tail is the disposable end.
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
/// - Title view: `WebViewTitleView` — title + subtitle slots driven by the
///   URL-fallback state machine. The current page URL falls through the
///   highest slot the caller hasn't claimed (title, then subtitle); once the
///   caller supplies a value via `patchWindowText` (or `openUrl`'s initial chrome)
///   that slot is theirs and the URL drops to the next, then to neither.
///   `url`-KVO keeps whichever slot still shows the URL in sync with
///   navigation. See `applyWindowText` / `renderUrlFallback`.
/// - Bottom toolbar: Back / Forward (KVO-driven enabled state), then a
///   caller-controlled `message` label for status text (e.g.
///   "34 resources collected").
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

  /// Called when the user dismisses the sheet — the Close toolbar button or an
  /// interactive swipe-to-dismiss. The plugin HIDES the instance (keeps it
  /// alive + running) and emits `hidden`; nothing is torn down here.
  var onUserDismiss: (() -> Void)?

  /// Called when the webview is torn down — a host `dispose()`, the hidden-idle
  /// backstop, or natural teardown (this controller's `deinit`). The plugin
  /// frees its captured state and emits `disposed`.
  var onDispose: (() -> Void)?

  /// Guards against a double `onDispose` between `requestDispose` and `deinit`:
  /// set once the instance has been disposed so the `deinit` backstop stays
  /// silent (a normal hide leaves this `false`, so an eventual deallocation
  /// without an explicit dispose still emits `disposed`).
  private var didDispose = false

  /// The content webview's current full URL — the value the URL fallback paints
  /// into whichever slot the caller hasn't claimed. Updated by `onNavigate`
  /// (driven by `url`-KVO) so the visible URL tracks navigation.
  private var url: String
  /// Whether the caller has supplied a `title` (via `open`'s initial chrome or
  /// `patchWindowText` — any present value, including `""`). Once `true` the
  /// title slot is caller-owned and the URL falls through to the subtitle.
  private var titleClaimed = false
  /// Whether the caller has supplied a `subtitle`. Once `true` — and the title
  /// is also claimed — the URL is shown in neither slot.
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

    // Observe the nav-arrow enabled state and the page URL. The `url`
    // observation feeds `onNavigate`, which re-renders the URL fallback so
    // whichever slot still shows the URL (the title until claimed, then the
    // subtitle) tracks navigation. Caller-claimed slots are left untouched.
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
    // The toolbar is hidden by default on a freshly-created
    // UINavigationController; reveal it here so the back/forward items
    // render. Idempotent.
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
    // The toolbar Close button is a USER dismissal — HIDE (keep alive), not a
    // teardown. Animate the sheet away, then fire `onUserDismiss` from the
    // completion. UIKit does NOT call `presentationControllerDidDismiss` for a
    // programmatic `dismiss(animated:)`, so this does not double-emit with the
    // swipe path.
    dismiss(animated: true) { [weak self] in
      self?.onUserDismiss?()
    }
  }

  /// Tear the instance down — the landing point for a host `dispose()` and the
  /// hidden-idle backstop. When the sheet is on screen (`wasVisible`), animate
  /// it away first and fire `onDispose` from the dismiss completion; when it's
  /// already hidden there is nothing to dismiss, so fire `onDispose` directly.
  /// Marks `didDispose` so the `deinit` backstop stays silent. UIKit does NOT
  /// call `presentationControllerDidDismiss` for this programmatic dismiss, so
  /// the swipe path never double-fires.
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

  /// Interactive dismissal (swiping the page sheet down) bypasses the Close
  /// button, so UIKit reports it here instead. It is a USER dismissal — route it
  /// through the same `onUserDismiss` (HIDE) path. UIKit does NOT call this for
  /// programmatic `dismiss(animated:)`, so the Close-button / host-`hide` /
  /// host-`dispose` paths (which fire from their own dismiss completions) do not
  /// double-emit.
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    onUserDismiss?()
  }

  /// Apply the caller-supplied window text in one call — `nil` = leave
  /// unchanged; any present value (including `""`) *claims* that slot for the
  /// caller and is shown verbatim. Shared by `openUrl`'s initial chrome, the
  /// `patchWindowText` command, and the re-wire path so the claim + patch
  /// semantics live in one place. After applying, `renderUrlFallback` paints the
  /// page URL into the highest slot the caller still hasn't claimed.
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

  /// Paint the current page `url` into the highest slot the caller has not
  /// claimed: the title until a caller `title` arrives, then the subtitle until
  /// a caller `subtitle` arrives, then nowhere (both slots caller-owned).
  /// Caller-claimed slots are never overwritten here — they hold the values set
  /// in `applyWindowText`.
  private func renderUrlFallback() {
    if !titleClaimed {
      updateTitle(url)
    } else if !subtitleClaimed {
      updateSubtitle(url)
    }
  }

  /// Sync the URL fallback to a navigation. Driven by `url`-KVO; rewrites
  /// whichever slot still shows the URL and no-ops once both slots are claimed.
  func onNavigate(_ newUrl: String) {
    url = newUrl
    renderUrlFallback()
  }

  /// Reset the claim state for a re-`openUrl()` against this live native webview: the new
  /// open starts with both slots unclaimed (URL back in the title) and a blank
  /// message, then re-applies the caller's initial chrome. Mirrors what a fresh
  /// `present()` shows, so reusing the native webview is indistinguishable from
  /// rebuilding it.
  func reopen(url newUrl: String, title: String?, subtitle: String?, message: String?) {
    url = newUrl
    titleClaimed = false
    subtitleClaimed = false
    updateMessage("")
    applyWindowText(title: title, subtitle: subtitle, message: message)
  }

  /// Write the title slot directly (no claim bookkeeping). Empty string clears.
  /// Used by `applyWindowText` for a caller-claimed title and by
  /// `renderUrlFallback` for the URL.
  func updateTitle(_ title: String) {
    titleView.titleLabel.text = title.isEmpty ? nil : title
  }

  /// Write the subtitle slot directly (no claim bookkeeping). Empty string
  /// clears (hiding the row). Used by `applyWindowText` for a caller-claimed
  /// subtitle and by `renderUrlFallback` for the URL.
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

  /// (Re)compose `toolbarItems` from the current `messageLabel.text` —
  /// includes the message slot only when there's text to render. Single
  /// writer for `toolbarItems` so we never end up with a stranded fixed
  /// spacer or an empty-customView dot in the bar.
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
    // Natural-teardown backstop: if this controller is being deallocated without
    // an explicit `dispose` having run (e.g. the host app tearing down its view
    // hierarchy while the instance was still hidden), emit `disposed` so the
    // host's collector still sees a terminal event. Skipped when `requestDispose`
    // already fired (it set `didDispose`).
    if !didDispose {
      onDispose?()
    }
    // `WKUserContentController` retains its script-message handlers strongly;
    // drop ours so the bridge (and the webview graph behind it) can deallocate,
    // matching the lifecycle `NativeWebviewMessageBridge`'s doc comment describes.
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
