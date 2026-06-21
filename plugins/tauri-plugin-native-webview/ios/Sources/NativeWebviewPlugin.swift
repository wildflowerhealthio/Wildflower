import Tauri
import UIKit
import WebKit

/// Arguments decoded from `invoke('plugin:native-webview|open', { url, initScript })`.
/// Keys match `OpenRequest`'s camelCase serde wire shape; `initScript` is
/// omitted when absent.
class OpenArgs: Decodable {
  let url: String
  let initScript: String?
}

/// Breaks the well-known retain cycle that a `WKUserContentController` script
/// message handler creates (controller → handler → web view → controller) by
/// holding the real handler weakly. Without this the popup's `WKWebView` leaks.
class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  weak var delegate: WKScriptMessageHandler?

  init(delegate: WKScriptMessageHandler) {
    self.delegate = delegate
    super.init()
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    delegate?.userContentController(userContentController, didReceive: message)
  }
}

/// Native web view popup plugin.
///
/// `open` presents a `WKWebView` inside a `UINavigationController` (native
/// Close button + the page host as the title) as a page sheet. A document-start
/// `WKUserScript` is injected into every page on every origin, and each ping it
/// posts back is forwarded to the host webview's JS listeners via the Tauri
/// plugin event channel (`trigger`).
class NativeWebviewPlugin: Plugin, WKScriptMessageHandler {
  /// `window.webkit.messageHandlers.<name>` the injected script posts to.
  static let messageHandlerName = "nativeWebview"

  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("native-webview: invalid URL \(args.url)")
      return
    }

    DispatchQueue.main.async {
      self.present(url: url, initScript: args.initScript)
      invoke.resolve(["opened": true])
    }
  }

  private func present(url: URL, initScript: String?) {
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
    contentController.add(
      WeakScriptMessageHandler(delegate: self),
      name: NativeWebviewPlugin.messageHandlerName
    )

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = contentController

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.load(URLRequest(url: url))

    let browser = NativeWebviewController(webView: webView, initialHost: url.host)
    browser.onClose = { [weak self] in
      self?.trigger("closed", data: [:])
    }

    let navigation = UINavigationController(rootViewController: browser)
    navigation.modalPresentationStyle = .pageSheet
    topViewController()?.present(navigation, animated: true)
  }

  // MARK: WKScriptMessageHandler

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    // The injected adapter posts an opaque JSON string (the sniffer's wire
    // message). Forward it verbatim to the host webview's plugin listeners
    // (`addPluginListener('native-webview', 'message', …)`), which parse it.
    // `JSValue` is only string-literal-expressible, so wrap the `String`.
    guard message.name == NativeWebviewPlugin.messageHandlerName,
      let payload = message.body as? String
    else { return }

    trigger("message", data: ["payload": .string(payload)])
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

/// Hosts the popup `WKWebView` with native chrome: a Close button and the page
/// host as the navigation title (kept in sync as the user navigates).
class NativeWebviewController: UIViewController {
  private let webView: WKWebView
  private var urlObservation: NSKeyValueObservation?

  /// Called after the sheet is dismissed via the Close button.
  var onClose: (() -> Void)?

  init(webView: WKWebView, initialHost: String?) {
    self.webView = webView
    super.init(nibName: nil, bundle: nil)
    title = initialHost
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
    urlObservation = webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
      self?.title = webView.url?.host
    }
  }

  @objc private func closeTapped() {
    dismiss(animated: true) { [weak self] in
      self?.onClose?()
    }
  }

  deinit {
    urlObservation?.invalidate()
  }
}

/// Entry point Tauri's `ios_plugin_binding!(init_plugin_native_webview)` links
/// against; returns the plugin instance Tauri drives.
@_cdecl("init_plugin_native_webview")
func initPlugin() -> Plugin {
  return NativeWebviewPlugin()
}
