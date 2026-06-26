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
  /// Initial chrome; omitted keys decode to nil (leave unchanged). Matches
  /// `OpenRequest`'s `initialTitle` / `initialSubtitle` / `initialMessage` wire shape.
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

/// Native webview plugin — iOS backend of the cross-platform lifecycle protocol.
/// See docs/Lifecycle and Races Explanation.md for the shared model; this type implements it
/// with a `WKWebView` inside a `UINavigationController` presented as a page sheet.
///
/// Orientation: `openUrl` builds (HIDDEN if absent) and navigates without
/// presenting; `show` presents; `hide` removes from view but keeps the instance
/// alive; `dispose` tears it down. A document-start `WKUserScript` is injected on
/// every origin and each ping is forwarded to the caller's per-instance
/// [`Channel`]. See the doc's "Visibility, liveness, and existence are
/// independent" and "User dismissal hides; only `dispose` tears down".
class NativeWebviewPlugin: Plugin {
  /// `window.webkit.messageHandlers.<name>` the injected script posts to.
  static let messageHandlerName = "nativeWebview"

  /// Idle teardown backstop duration (mobile 5-min idle) — see Teardown
  /// backstops in docs/Lifecycle and Races Explanation.md.
  static let idleTeardownSeconds: TimeInterval = 5 * 60

  /// The current `WKWebView`, if any. Held STRONGLY so a hidden instance stays
  /// alive; cleared only in `handleDisposed()`, after which `evaluateJs` rejects.
  private var currentWebView: WKWebView?

  /// The current controller — target for chrome updates and `show`/`hide`.
  /// Strongly held (keep-alive-while-hidden).
  private var currentController: NativeWebviewController?

  /// The current message bridge; its `channel` is rebound on Re-open rewire.
  /// Strongly held (keep-alive-while-hidden).
  private var currentBridge: NativeWebviewMessageBridge?

  /// The `UINavigationController` wrapping `currentController` — `show`
  /// re-presents and `hide` dismisses it without teardown. Strongly held.
  private var currentNavigation: UINavigationController?

  /// Whether the instance is on screen — tracked explicitly because visibility
  /// and existence are independent (see the doc's first section).
  private var isVisible = false

  /// Deferred replay armed by the dispose→open switch-demo race: a closure that
  /// presents the fresh instance, run from `handleDisposed` once teardown
  /// completes (and which then suppresses the `disposed` echo). See "The
  /// dispose→open \"switch-demo\" race" in docs/Lifecycle and Races Explanation.md.
  private var onDisposeFinishedHandler: (() -> Void)?

  /// The `Invoke` owned by [`onDisposeFinishedHandler`], held separately so a
  /// second `openUrl()` superseding a still-queued one can reject it (no timeout
  /// on `openUrl`). See "The dispose→open \"switch-demo\" race".
  private var pendingInvoke: Invoke?

  /// The `disposing` flag of the switch-demo race guard: set between a `dispose`
  /// (host or idle backstop) and the `handleDisposed` that completes teardown. A
  /// same-tick `openUrl` queues a replay only when set; a `hide` leaves it false
  /// and rewires in place. See "The dispose→open \"switch-demo\" race".
  private var isDisposing = false

  /// Idle teardown timer (Teardown backstops). Fires on the main run loop.
  private var idleTimer: Timer?

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

    DispatchQueue.main.async {
      self.resetIdleTimer()  // a command counts as activity
      // Dispose→open switch-demo race: a dispose teardown is in flight, so queue
      // a replay (run from `handleDisposed`) instead of re-wiring the doomed
      // instance. A HIDE never arms `isDisposing`, so it falls through to the
      // Re-open rewire branch below. See docs/Lifecycle and Races Explanation.md.
      if self.isDisposing {
        // Supersede any already-queued openUrl so its `await` isn't left hung
        // (last-write-wins would otherwise drop its `resolve`).
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
      // Re-open rewire — existing instance (visible OR hidden), not being torn
      // down: rebind the channel and re-apply initScript/chrome, navigate in
      // place, PRESERVE visibility (do NOT present). The new `initScript` is
      // `eval`'d into the current page and re-registered as document-start for
      // future loads; `reopen` resets the URL-fallback claim state. See
      // docs/Lifecycle and Races Explanation.md.
      if let existing = self.currentWebView, let bridge = self.currentBridge {
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
      // No instance: build one HIDDEN — `present` constructs the webview graph
      // but does not call UIKit `present(_:)` (build/navigate are separate from
      // presentation; see the doc's first section).
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
      // Dispose teardown in flight: nothing presentable (presenting would race
      // UIKit's dismiss-in-progress no-op and desync `isVisible` on a doomed
      // instance). See "The dispose→open \"switch-demo\" race".
      if self.isDisposing {
        invoke.resolve(["requestCausedShow": false])
        return
      }
      guard let navigation = self.currentNavigation else {
        invoke.resolve(["requestCausedShow": false])
        return
      }
      if self.isVisible {
        // Already on screen — idempotent, but no transition caused.
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
      // Flip `isVisible` synchronously (mirroring Android's `hideDialog`) so a
      // second `hide()` racing this in-flight animated dismiss sees the new
      // state and no-ops instead of dismissing again and double-emitting
      // `hidden`. `handleHidden` re-sets it from the dismiss completion, which is
      // idempotent.
      self.isVisible = false
      // Host `hide()` shares `handleHidden()` with user dismissal, fired here
      // from the dismiss completion. See "User dismissal hides; only `dispose`
      // tears down".
      navigation.dismiss(animated: true) { [weak self] in
        self?.handleHidden()
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
    DispatchQueue.main.async {
      self.cancelIdleTimer()
      guard let controller = self.currentController else {
        invoke.resolve(["requestCausedDispose": false])
        return
      }
      // Arm the switch-demo race guard before teardown; cleared in
      // `handleDisposed`. See "The dispose→open \"switch-demo\" race".
      self.isDisposing = true
      controller.requestDispose(wasVisible: self.isVisible)
      invoke.resolve(["requestCausedDispose": true])
    }
  }

  /// An instance exists but is off screen — the only state the idle backstop reclaims.
  private var hasHiddenInstance: Bool {
    currentController != nil && !isVisible
  }

  /// (Re)arm the idle teardown backstop (Teardown backstops). Called on every
  /// activity (inbound bridge message or any command); cancels instead of arming
  /// unless `hasHiddenInstance`. Main-thread only (Timer schedules on the current
  /// run loop, and all the plugin's UI work is main-thread).
  private func resetIdleTimer() {
    idleTimer?.invalidate()
    idleTimer = nil
    guard self.hasHiddenInstance else { return }
    idleTimer = Timer.scheduledTimer(
      withTimeInterval: NativeWebviewPlugin.idleTeardownSeconds,
      repeats: false
    ) { [weak self] _ in
      guard let self = self, let controller = self.currentController, !self.isVisible
      else { return }
      // Idle past the backstop — auto-dispose, arming the race guard for
      // symmetry with a host `dispose`. See Teardown backstops.
      self.isDisposing = true
      controller.requestDispose(wasVisible: false)
    }
  }

  /// Cancel the idle teardown backstop (instance shown or disposed).
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
      self.resetIdleTimer()  // a command counts as activity
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
  private func handleHidden() {
    guard self.currentController != nil else { return }
    // A user swipe can fire `presentationControllerDidDismiss` *during* a
    // `dispose()` whose own dismiss is still animating. Ignore it while
    // disposing: otherwise we'd emit a spurious `hidden` and re-arm the idle
    // timer `dispose` just cancelled, both ahead of the `disposed` that
    // `handleDisposed` emits. Mirrors Android's `show()`-guards-on-`isDisposing`
    // posture. See "The dispose→open \"switch-demo\" race".
    guard !self.isDisposing else { return }
    self.isVisible = false
    // Lowercase tag matches `models.rs`; `JsonObject` pins the non-throwing send overload.
    let data: JsonObject = ["event": "hidden"]
    self.currentBridge?.channel.send(data)
    self.resetIdleTimer()  // now hidden — start the idle backstop counting down
  }

  /// React to the instance being torn down — shared by a host `dispose()`, the
  /// idle backstop, and natural teardown (controller deinit). Frees captured
  /// state and, unless a switch-demo replay was queued, emits `disposed`. See
  /// "The dispose→open \"switch-demo\" race".
  private func handleDisposed() {
    self.cancelIdleTimer()
    // Read the latest (possibly re-wired) channel BEFORE clearing the bridge so
    // the `disposed` echo follows a fresh `openUrl`'s channel to the most recent
    // caller (matches desktop's `CurrentChannel` handling). See Re-open rewire.
    let disposeChannel = self.currentBridge?.channel
    self.currentWebView = nil
    self.currentController = nil
    self.currentBridge = nil
    self.currentNavigation = nil
    self.isVisible = false
    self.isDisposing = false
    // If a switch-demo replay was queued, run it and suppress the `disposed`
    // echo; otherwise emit `disposed`. See "The dispose→open \"switch-demo\" race".
    if let pending = self.onDisposeFinishedHandler {
      self.onDisposeFinishedHandler = nil
      self.pendingInvoke = nil
      pending()
    } else {
      // Lowercase tag matches `models.rs`; `JsonObject` pins the non-throwing send overload.
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
    currentBridge = bridge
    bridge.onActivity = { [weak self] in self?.resetIdleTimer() }  // inbound traffic is activity

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = contentController

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.load(URLRequest(url: url))
    currentWebView = webView

    let browser = NativeWebviewController(webView: webView, initialUrl: url.absoluteString)
    currentController = browser
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
      self?.handleHidden()
    }
    browser.onDispose = { [weak self] in
      self?.handleDisposed()
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
    currentNavigation = navigation
    isVisible = false
    // Arm the idle backstop so a built-but-never-shown instance is reclaimed.
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
