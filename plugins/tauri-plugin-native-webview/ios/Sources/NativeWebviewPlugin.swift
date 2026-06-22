import Tauri
import UIKit
import WebKit

/// Arguments decoded from `invoke('plugin:native-webview|open', { url, initScript, channel })`.
/// Keys match `OpenRequest`'s camelCase serde wire shape; `initScript` is
/// omitted when absent. `channel` is a Tauri `Channel<PopupEvent>` the caller
/// receives popup events on (`{"event":"message", "payload": …}` /
/// `{"event":"closed"}`) — see `models.rs` `PopupEvent`.
class OpenArgs: Decodable {
  let url: String
  let initScript: String?
  let channel: Channel
}

/// Arguments decoded from `invoke('plugin:native-webview|send', { script })`.
/// Keys match `SendRequest`'s camelCase serde wire shape. The host evaluates
/// `script` verbatim in the popup webview — typically a
/// `window.__nativeWebviewReceive(JSON.stringify(...))` call carrying a bridge
/// envelope.
class SendArgs: Decodable {
  let script: String
}

/// Arguments decoded from `invoke('plugin:native-webview|setChrome', { title?, subtitle?, message? })`.
/// Keys match `SetChromeRequest`'s camelCase serde wire shape. Each field is
/// optional: `nil` / absent means "leave unchanged"; empty string clears that
/// label. The plugin batches all three to keep multi-field updates flicker-free.
class SetChromeArgs: Decodable {
  let title: String?
  let subtitle: String?
  let message: String?
}

/// Per-popup script message handler: holds the caller's [`Channel`] and
/// forwards each `window.webkit.messageHandlers.nativeWebview.postMessage(...)`
/// call as a `PopupEvent.message` payload. Per-popup (rather than plugin-
/// singleton) so a stacked second `open` doesn't redirect the first popup's
/// events into the second popup's channel.
///
/// `WKUserContentController` retains its script-message handlers strongly, and
/// a popup's `userContentController.add(handler, name: ...)` then retains the
/// handler back through the webview's configuration — the chain that
/// historically required the `WeakScriptMessageHandler` indirection. We sidestep
/// the cycle by removing this handler in the popup controller's `deinit`.
class PopupMessageBridge: NSObject, WKScriptMessageHandler {
  let channel: Channel

  init(channel: Channel) {
    self.channel = channel
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    // The injected adapter posts an opaque JSON string (the sniffer's wire
    // message). Forward it verbatim through the caller's channel as a
    // `PopupEvent.message` (matches `models.rs` `PopupEvent` serde shape).
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

/// Native web view popup plugin.
///
/// `open` presents a `WKWebView` inside a `UINavigationController` (native
/// Close button + the page host as the title) as a page sheet. A document-start
/// `WKUserScript` is injected into every page on every origin, and each ping it
/// posts back is forwarded to the Rust caller through the per-popup
/// [`Channel`] passed in `OpenArgs` (no JS-side bridge).
class NativeWebviewPlugin: Plugin {
  /// `window.webkit.messageHandlers.<name>` the injected script posts to.
  static let messageHandlerName = "nativeWebview"

  /// The currently-presented popup webview, if any. Captured on `open` so
  /// `send` can `evaluateJavaScript(...)` into it; cleared on close to let
  /// `send` fail loudly with a "no popup open" reject. Weak so a popup
  /// dismissed by other means (system back-swipe on the sheet, host app
  /// teardown) doesn't keep the webview alive past its presentation.
  private weak var currentWebView: WKWebView?

  /// The currently-presented popup controller, if any. Captured on `open`
  /// so `setSubtitle` can update its chrome's subtitle label. Same `weak`
  /// rationale as `currentWebView` — the controller's lifetime is the
  /// UINavigationController's, not the plugin's.
  private weak var currentController: NativeWebviewController?

  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("native-webview: invalid URL \(args.url)")
      return
    }

    DispatchQueue.main.async {
      // Already presented: navigate in-place rather than stacking another
      // sheet on top. The original `WKUserScript(.atDocumentStart)` fires
      // again on the new navigation, so the caller's `initScript` keeps
      // running for the new page; the per-popup `PopupMessageBridge` and
      // its captured `Channel` stay wired across navigations. A different
      // `initScript` / `channel` on this second call is silently ignored
      // — for browser-sniffer's case both are stable across opens.
      if let existing = self.currentWebView {
        existing.load(URLRequest(url: url))
        invoke.resolve(["opened": true])
        return
      }
      self.present(url: url, initScript: args.initScript, channel: args.channel)
      invoke.resolve(["opened": true])
    }
  }

  /// Evaluate JS inside the currently-presented popup webview. Rejects if no
  /// popup is open (caller should `await invoke('plugin:native-webview|open',
  /// …)` first). The evaluation itself is asynchronous and best-effort — its
  /// return value and any thrown JS error are not surfaced.
  @objc public func send(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SendArgs.self)
    DispatchQueue.main.async {
      guard let webView = self.currentWebView else {
        invoke.reject("native-webview: no popup open")
        return
      }
      webView.evaluateJavaScript(args.script, completionHandler: nil)
      invoke.resolve(["sent": true])
    }
  }

  /// Update one or more of the popup chrome's three labels
  /// (`title`, `subtitle`, `message`). Each field is independently
  /// optional: `nil` / absent = leave unchanged; empty string clears.
  /// Resolves with `{set: true}` once applied; `{set: false}` (not a
  /// reject) when no popup is open, so callers can push speculatively
  /// across the popup's lifecycle without retry plumbing.
  @objc public func setChrome(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SetChromeArgs.self)
    DispatchQueue.main.async {
      guard let controller = self.currentController else {
        invoke.resolve(["set": false])
        return
      }
      if let title = args.title { controller.updateTitle(title) }
      if let subtitle = args.subtitle { controller.updateSubtitle(subtitle) }
      if let message = args.message { controller.updateMessage(message) }
      invoke.resolve(["set": true])
    }
  }

  /// Dismiss the currently-presented popup. Idempotent — resolves with
  /// `{closed: false}` when no popup is open. Delegates to the controller's
  /// `requestClose()`, which routes through the same `dismiss` + `onClose`
  /// pipeline the in-toolbar Close button uses, so the host-initiated
  /// dismissal emits `PopupEvent::Closed` on the channel just like the
  /// user-initiated one.
  @objc public func close(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      guard let controller = self.currentController else {
        invoke.resolve(["closed": false])
        return
      }
      controller.requestClose()
      invoke.resolve(["closed": true])
    }
  }

  private func present(url: URL, initScript: String?, channel: Channel) {
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
    let bridge = PopupMessageBridge(channel: channel)
    contentController.add(bridge, name: NativeWebviewPlugin.messageHandlerName)

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = contentController

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.load(URLRequest(url: url))
    // Capture so `send` can target it; cleared in `onClose` below.
    currentWebView = webView

    let browser = NativeWebviewController(webView: webView, initialHost: url.host)
    // Capture so `setSubtitle` can target the controller's title view;
    // cleared in `onClose` below alongside `currentWebView`.
    currentController = browser
    browser.onClose = { [weak self] in
      self?.currentWebView = nil
      self?.currentController = nil
      // PopupEvent.closed (lowercase tag) — matches the `models.rs` shape.
      // `JsonObject` annotation pins the non-throwing overload (see above).
      let data: JsonObject = ["event": "closed"]
      channel.send(data)
    }

    let navigation = UINavigationController(rootViewController: browser)
    navigation.modalPresentationStyle = .pageSheet
    // A `.pageSheet` is interactively swipe-dismissable. That gesture does
    // NOT route through `requestClose()`, so register the controller as the
    // sheet's presentation delegate to catch it and still fire `onClose`
    // (see `presentationControllerDidDismiss`). Without this, a swipe-away
    // never emits `PopupEvent::Closed` and the host's collector idle-times-out.
    navigation.presentationController?.delegate = browser
    // Show the navigation controller's bottom toolbar so the controller's
    // `toolbarItems` (back / forward) render. The view controller hides /
    // shows it on appear, but flipping it here too avoids a flash at open.
    navigation.isToolbarHidden = false
    topViewController()?.present(navigation, animated: true)
  }

  /// The top-most presented view controller to present the popup from.
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
    // Long hosts: truncate from the head so the registrable suffix
    // (`example.test`) stays visible — the leftmost subdomain is the
    // disposable part.
    titleLabel.lineBreakMode = .byTruncatingHead

    subtitleLabel.font = .systemFont(ofSize: 11, weight: .regular)
    subtitleLabel.textAlignment = .center
    subtitleLabel.textColor = .secondaryLabel
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

/// Hosts the popup `WKWebView` with native chrome:
///
/// - Left bar item: Close (dismisses the sheet, fires `onClose`).
/// - Right bar item: Refresh (`webView.reload()`).
/// - Title view: `WebViewTitleView` — caller-controlled title + subtitle.
///   Defaulted to the URL host on construction; the plugin does NOT
///   auto-update on navigation, so the caller drives any subsequent
///   changes via `setChrome`.
/// - Bottom toolbar: Back / Forward (KVO-driven enabled state), then a
///   caller-controlled `message` label for status text (e.g.
///   "34 resources collected").
class NativeWebviewController: UIViewController, UIAdaptivePresentationControllerDelegate {
  private let webView: WKWebView
  private var canGoBackObservation: NSKeyValueObservation?
  private var canGoForwardObservation: NSKeyValueObservation?
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

  init(webView: WKWebView, initialHost: String?) {
    self.webView = webView
    super.init(nibName: nil, bundle: nil)
    titleView.titleLabel.text = initialHost
    navigationItem.titleView = titleView
    messageLabel.font = .systemFont(ofSize: 13, weight: .regular)
    messageLabel.textColor = .secondaryLabel
    messageLabel.lineBreakMode = .byTruncatingTail
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

    // Title is owned by the caller from now on — observe only the nav
    // arrow enabled state. URL KVO for title auto-update is gone on
    // purpose: per the design, the host (sniffer / whatever) drives the
    // title via `setChrome`. Initial value is the URL host set in init.
    canGoBackObservation = webView.observe(\.canGoBack, options: [.new]) { [weak self] webView, _ in
      self?.backItem.isEnabled = webView.canGoBack
    }
    canGoForwardObservation = webView.observe(\.canGoForward, options: [.new]) {
      [weak self] webView, _ in
      self?.forwardItem.isEnabled = webView.canGoForward
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
  /// `onClose` on completion — so the channel's `PopupEvent::Closed` lands
  /// once per popup regardless of whether dismissal was user- or host-
  /// initiated.
  func requestClose() {
    dismiss(animated: true) { [weak self] in
      self?.onClose?()
    }
  }

  /// Interactive dismissal (swiping the page sheet down) bypasses
  /// `requestClose()`, so UIKit reports it here instead. Route it through the
  /// same `onClose` path so `PopupEvent::Closed` fires exactly once whether the
  /// user tapped Close, the host called `close`, or the sheet was swiped away.
  /// UIKit does NOT call this for programmatic `dismiss(animated:)`, so the
  /// Close-button / host-`close` path (which fires `onClose` from its dismiss
  /// completion) does not double-emit.
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    onClose?()
  }

  /// Push a new title (URL-host slot) into the chrome. Called from the
  /// plugin's `setChrome` command on the main thread. Empty string clears.
  func updateTitle(_ title: String) {
    titleView.titleLabel.text = title.isEmpty ? nil : title
  }

  /// Push a new subtitle into the chrome's title view. Called from the
  /// plugin's `setChrome` command on the main thread. Empty string clears.
  func updateSubtitle(_ subtitle: String) {
    titleView.setSubtitle(subtitle.isEmpty ? nil : subtitle)
  }

  /// Push a new bottom-bar message. Called from the plugin's `setChrome`
  /// command on the main thread. Empty string clears. The label's intrinsic
  /// size resizes automatically inside the toolbar; the toolbar items are
  /// rebuilt so an empty message drops the slot entirely (rather than
  /// rendering a vestigial dot in the bar).
  func updateMessage(_ message: String) {
    messageLabel.text = message.isEmpty ? nil : message
    messageLabel.sizeToFit()
    rebuildToolbarItems()
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
    // `WKUserContentController` retains its script-message handlers strongly;
    // drop ours so the bridge (and the webview graph behind it) can deallocate,
    // matching the lifecycle `PopupMessageBridge`'s doc comment describes.
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
