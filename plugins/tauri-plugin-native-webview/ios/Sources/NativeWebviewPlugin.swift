import Tauri
import UIKit
import WebKit

/// Arguments decoded from `invoke('plugin:native-webview|open', { url })`.
/// The `url` key matches `OpenRequest`'s camelCase serde wire shape.
class OpenArgs: Decodable {
  let url: String
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

  /// Injected at `.atDocumentStart` into all frames on ANY origin. Thin slice:
  /// it only proves at-document-start injection by posting lifecycle pings.
  /// The real sniffer body (fetch/XHR/console shims) replaces this string in a
  /// later increment.
  static let injectedSource = """
    (function () {
      try {
        var post = function (payload) {
          if (
            window.webkit &&
            window.webkit.messageHandlers &&
            window.webkit.messageHandlers.\(messageHandlerName)
          ) {
            window.webkit.messageHandlers.\(messageHandlerName).postMessage(payload);
          }
        };
        post({ kind: "injected", url: location.href });
        document.addEventListener("DOMContentLoaded", function () {
          post({ kind: "domcontentloaded", url: location.href });
        });
        window.addEventListener("load", function () {
          post({ kind: "load", url: location.href });
        });
      } catch (error) {
        // Never throw into the host page.
      }
    })();
    """

  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("native-webview: invalid URL \(args.url)")
      return
    }

    DispatchQueue.main.async {
      self.present(url: url)
      invoke.resolve(["opened": true])
    }
  }

  private func present(url: URL) {
    let contentController = WKUserContentController()
    let userScript = WKUserScript(
      source: NativeWebviewPlugin.injectedSource,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: false
    )
    contentController.addUserScript(userScript)
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
    guard message.name == NativeWebviewPlugin.messageHandlerName,
      let body = message.body as? [String: Any],
      let kind = body["kind"] as? String,
      let pageURL = body["url"] as? String
    else { return }

    // Forward to the host webview's plugin listeners
    // (`addPluginListener('native-webview', 'message', …)`). `JSValue` is only
    // string-literal-expressible, so wrap the `String` variables explicitly.
    trigger("message", data: ["kind": .string(kind), "url": .string(pageURL)])
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
