import Tauri
import UIKit
import WebKit

/// Arguments decoded from `invoke('plugin:native-webview|open', { url, initScript, nativeWebviewEventChannel })`.
/// Keys match `OpenRequest`'s camelCase serde wire shape; `initScript` is
/// omitted when absent. `nativeWebviewEventChannel` is a Tauri `Channel<NativeWebviewEvent>`
/// the caller receives native webview events on (`{"event":"message", "payload": …}` /
/// `{"event":"closed"}`) — see `models.rs` `NativeWebviewEvent`.
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

/// Arguments decoded from
/// `invoke('plugin:native-webview|close', { suppressCloseEvent? })`. Matches
/// `CloseRequest`'s camelCase serde wire shape. Optional with a `false` default
/// (absent key = emit `Closed`); set `true` by a host that already observed the
/// terminal event that prompted the close, so the resulting dismissal stays
/// silent on the channel.
class CloseArgs: Decodable {
  let suppressCloseEvent: Bool?
}

/// Per-native-webview script message handler: holds the caller's [`Channel`] and
/// forwards each `window.webkit.messageHandlers.nativeWebview.postMessage(...)`
/// call as a `NativeWebviewEvent.message` payload. Per-native-webview (rather than plugin-
/// singleton) so a stacked second `open` doesn't redirect the first native webview's
/// events into the second native webview's channel.
///
/// `channel` is `var` so a second `open()` against an existing native webview can
/// rebind it without rebuilding the webview — see `NativeWebviewPlugin.open`'s
/// re-wire branch.
///
/// `WKUserContentController` retains its script-message handlers strongly, and
/// a native webview's `userContentController.add(handler, name: ...)` then retains the
/// handler back through the webview's configuration — the chain that
/// historically required the `WeakScriptMessageHandler` indirection. We sidestep
/// the cycle by removing this handler in the native webview controller's `deinit`.
class NativeWebviewMessageBridge: NSObject, WKScriptMessageHandler {
  var channel: Channel

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

    let data: JsonObject = ["event": "message", "payload": payload]
    channel.send(data)
  }
}

/// Native web view plugin.
///
/// `open` presents a `WKWebView` inside a `UINavigationController` (native
/// Close button + the page URL as the title, until the caller claims it) as a
/// page sheet. A document-start
/// `WKUserScript` is injected into every page on every origin, and each ping it
/// posts back is forwarded to the Rust caller through the per-native-webview
/// [`Channel`] passed in `OpenArgs` (no JS-side bridge).
class NativeWebviewPlugin: Plugin {
  /// `window.webkit.messageHandlers.<name>` the injected script posts to.
  static let messageHandlerName = "nativeWebview"

  /// The currently-presented native webview, if any. Captured on `open` so
  /// `evaluateJs` can `evaluateJavaScript(...)` into it; cleared on close to let
  /// `evaluateJs` fail loudly with a "no native webview open" reject. Weak so a native
  /// webview dismissed by other means (system back-swipe on the sheet, host app
  /// teardown) doesn't keep the webview alive past its presentation.
  private weak var currentWebView: WKWebView?

  /// The currently-presented native webview controller, if any. Captured on `open`
  /// so `applyWindowText` / `patchWindowText` can update its chrome labels.
  /// Same `weak` rationale as `currentWebView` — the controller's lifetime is
  /// the UINavigationController's, not the plugin's.
  private weak var currentController: NativeWebviewController?

  /// The currently-presented native webview's message bridge. Captured on `open` so a
  /// subsequent `open()` against an existing native webview can re-bind its `channel`
  /// without rebuilding the webview (Task #7 re-wire). Same weak rationale.
  private weak var currentBridge: NativeWebviewMessageBridge?

  /// Set when a same-tick `open()` arrives while a previous native webview is in its
  /// dismiss animation (`controller.isBeingDismissed`). The pending closure
  /// runs from `onClose` once the animation completes, presenting the new
  /// native webview. When set, `onClose` suppresses the `Closed` channel echo — the
  /// native webview logically continues with new wiring rather than firing a spurious
  /// close (Task #10 close→reopen race guard).
  private var onCloseFinishedHandler: (() -> Void)?

  /// Set by a host `close(suppressCloseEvent: true)` before the dismiss so
  /// `onClose` skips the `Closed` channel echo for exactly that dismissal.
  /// Consumed (reset to `false`) the next time `onClose` fires — a user
  /// dismissal (Close button, swipe) never sets it, so those still emit.
  private var suppressNextCloseEvent = false

  /// The `Invoke` whose `resolve` is owned by [`onCloseFinishedHandler`]. Held
  /// separately so that if a *second* `open()` supersedes a still-queued one
  /// (both during the same dismiss animation), the superseded invoke can be
  /// rejected before its closure is overwritten — otherwise its JS promise
  /// would hang forever (there's no timeout on `open`).
  private var pendingInvoke: Invoke?

  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("native-webview: invalid URL \(args.url)")
      return
    }

    DispatchQueue.main.async {
      // Dismiss in flight (host `close()` or user swipe): queue a replay for
      // when the controller finishes dismissing. `onClose` consumes the
      // pending closure and suppresses the `Closed` echo so the native webview
      // logically continues with new wiring. Last-write-wins on rapid
      // repeats. (Task #10 race guard.)
      if let controller = self.currentController, controller.isBeingDismissed {
        // Supersede any already-queued open: settle its promise so a caller
        // doing two quick `open()`s during the dismiss animation doesn't get
        // a permanently-hung `await` for the first one (last-write-wins would
        // otherwise drop its `resolve`).
        self.pendingInvoke?.reject(
          "native-webview: superseded by a newer open() before the popup finished closing")
        self.pendingInvoke = invoke
        self.onCloseFinishedHandler = { [weak self] in
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
      // Already presented and not being dismissed: re-wire the existing
      // native webview in place. Channel rebinds via `bridge.channel = …`; the new
      // `initScript` is `eval`'d into the current page (NOT document-start
      // for the just-loaded one — caveat documented in `desktop.rs`) and
      // also added to the user content controller so future loads inside
      // this native webview run it at document-start. `reopen` resets the URL-fallback
      // claim state so the reused native webview starts fresh (URL back in the title),
      // then re-applies the caller's initial chrome. (Task #7 re-wire.)
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

  /// Evaluate JS inside the currently-presented native webview. Rejects if no
  /// native webview is open (caller should `await invoke('plugin:native-webview|open',
  /// …)` first). The evaluation itself is asynchronous and best-effort — its
  /// return value and any thrown JS error are not surfaced.
  @objc public func evaluateJs(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EvaluateJsArgs.self)
    DispatchQueue.main.async {
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

  /// Dismiss the currently-presented native webview. Idempotent — resolves with
  /// `{closedByRequest: false}` when no native webview is open. Delegates to the controller's
  /// `requestClose()`, which routes through the same `dismiss` + `onClose`
  /// pipeline the in-toolbar Close button uses.
  ///
  /// By default the host-initiated dismissal emits `NativeWebviewEvent::Closed` on the
  /// channel just like the user-initiated one. When the caller passes
  /// `suppressCloseEvent: true`, `onClose` skips that echo for this one
  /// dismissal — the host already observed the terminal event that prompted the
  /// close, so a second `Closed` would double-fire it.
  @objc public func close(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CloseArgs.self)
    DispatchQueue.main.async {
      guard let controller = self.currentController else {
        invoke.resolve(["closedByRequest": false])
        return
      }
      self.suppressNextCloseEvent = args.suppressCloseEvent ?? false
      controller.requestClose()
      invoke.resolve(["closedByRequest": true])
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
    // Capture so `open()`'s re-wire branch can swap `bridge.channel` without
    // rebuilding the webview (Task #7).
    currentBridge = bridge

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = contentController

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.load(URLRequest(url: url))
    // Capture so `evaluateJs` can target it; cleared in `onClose` below.
    currentWebView = webView

    let browser = NativeWebviewController(webView: webView, initialUrl: url.absoluteString)
    // Capture so `applyWindowText` can target the controller's chrome;
    // cleared in `onClose` below alongside `currentWebView`.
    currentController = browser
    // Apply caller-supplied initial chrome before presentation so the bar is
    // correct on first paint (nil = leave unchanged). The controller's URL
    // fallback shows the page URL in the highest slot the caller hasn't
    // claimed, so an `open` with no title/subtitle still shows where the native webview
    // navigated.
    browser.applyWindowText(
      title: initialTitle,
      subtitle: initialSubtitle,
      message: initialMessage
    )
    browser.onClose = { [weak self] in
      // Read the latest (possibly rewired) channel BEFORE tearing the bridge
      // down: a second `open()` rebinds `bridge.channel`, and the `Closed`
      // echo must follow it to the most recent caller — otherwise a caller
      // that re-opened with a fresh channel never sees the close on its new
      // channel (matches desktop's `CurrentChannel` handling).
      let closeChannel = self?.currentBridge?.channel ?? channel
      self?.currentWebView = nil
      self?.currentController = nil
      self?.currentBridge = nil
      // Consume the host-close suppression flag regardless of which branch
      // runs below, so it can never leak onto a later dismissal.
      let suppress = self?.suppressNextCloseEvent ?? false
      self?.suppressNextCloseEvent = false
      // If `open()` queued a replay during the dismiss animation, run it
      // now and skip the `Closed` echo — the native webview logically continues with
      // new wiring (Task #10). Otherwise this is a real dismiss; emit
      // `Closed` so the host's collector releases per-native-webview state — unless a
      // host `close(suppressCloseEvent: true)` asked us to stay silent.
      if let pending = self?.onCloseFinishedHandler {
        self?.onCloseFinishedHandler = nil
        self?.pendingInvoke = nil
        pending()
      } else if !suppress {
        // NativeWebviewEvent.closed (lowercase tag) — matches the `models.rs` shape.
        // `JsonObject` annotation pins the non-throwing overload (see above).
        let data: JsonObject = ["event": "closed"]
        closeChannel.send(data)
      }
    }

    let navigation = UINavigationController(rootViewController: browser)
    navigation.modalPresentationStyle = .pageSheet
    // A `.pageSheet` is interactively swipe-dismissable. That gesture does
    // NOT route through `requestClose()`, so register the controller as the
    // sheet's presentation delegate to catch it and still fire `onClose`
    // (see `presentationControllerDidDismiss`). Without this, a swipe-away
    // never emits `NativeWebviewEvent::Closed` and the host's collector idle-times-out.
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
    topViewController()?.present(navigation, animated: true)
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
/// - Left bar item: Close (dismisses the sheet, fires `onClose`).
/// - Right bar item: Refresh (`webView.reload()`).
/// - Title view: `WebViewTitleView` — title + subtitle slots driven by the
///   URL-fallback state machine. The current page URL falls through the
///   highest slot the caller hasn't claimed (title, then subtitle); once the
///   caller supplies a value via `patchWindowText` (or `open`'s initial chrome)
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

  /// Called after the sheet is dismissed via the Close button.
  var onClose: (() -> Void)?

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
    requestClose()
  }

  /// Programmatic close path shared by the in-toolbar Close button and the
  /// plugin's host-initiated `close` command. Animates dismissal and fires
  /// `onClose` on completion — so the channel's `NativeWebviewEvent::Closed` lands
  /// once per native webview regardless of whether dismissal was user- or host-
  /// initiated.
  func requestClose() {
    dismiss(animated: true) { [weak self] in
      self?.onClose?()
    }
  }

  /// Interactive dismissal (swiping the page sheet down) bypasses
  /// `requestClose()`, so UIKit reports it here instead. Route it through the
  /// same `onClose` path so `NativeWebviewEvent::Closed` fires exactly once whether the
  /// user tapped Close, the host called `close`, or the sheet was swiped away.
  /// UIKit does NOT call this for programmatic `dismiss(animated:)`, so the
  /// Close-button / host-`close` path (which fires `onClose` from its dismiss
  /// completion) does not double-emit.
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    onClose?()
  }

  /// Apply the caller-supplied window text in one call — `nil` = leave
  /// unchanged; any present value (including `""`) *claims* that slot for the
  /// caller and is shown verbatim. Shared by `open`'s initial chrome, the
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

  /// Reset the claim state for a re-`open()` against this live native webview: the new
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
