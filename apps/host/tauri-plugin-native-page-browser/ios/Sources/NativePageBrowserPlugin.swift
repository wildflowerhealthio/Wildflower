import SafariServices
import Tauri
import UIKit

/// Arguments decoded from `invoke('plugin:native-page-browser|open', { url, events })`.
/// Keys match `OpenRequest`'s camelCase serde wire shape (see `models.rs`).
/// `events` is a Tauri `Channel<BrowserEvent>` that hears `{"event":"closed"}`
/// once this view is gone.
class OpenArgs: Decodable {
  let url: String
  let events: Channel
}

/// The view the plugin is showing, with the channel its close reports on.
struct ShowingPage {
  let controller: SFSafariViewController
  let events: Channel
}

/// Presents an external URL in `SFSafariViewController`, the system's in-app
/// browser: the app can't script the page or read what's typed into it. One
/// view shows at a time — `open` dismisses a showing view (reporting its close)
/// before presenting the next. Every close, by the user or by a replacing
/// `open`, sends `{"event":"closed"}` exactly once on that view's channel.
class NativePageBrowserPlugin: Plugin, SFSafariViewControllerDelegate {
  /// The view on screen, or nil. Cleared before its close is reported, so each
  /// view reports once whichever path (Close button, edge swipe, replacing
  /// `open`) gets there first.
  private var showing: ShowingPage?

  /// Present `url`, first dismissing any showing view. Resolves once the
  /// presentation has started; rejects while a view is still animating in or
  /// out.
  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("native-page-browser: invalid URL \(args.url)")
      return
    }

    DispatchQueue.main.async {
      // UIKit ignores a dismiss or present started mid-transition and never
      // calls its completion, which would leave this open unresolved and the
      // showing view's close unreported.
      if let top = self.topViewController(), top.isBeingPresented || top.isBeingDismissed {
        invoke.reject("native-page-browser: a view is still opening or closing")
        return
      }
      self.dismissShowing {
        guard let presenter = self.topViewController() else {
          invoke.reject("native-page-browser: no view controller to present from")
          return
        }
        let controller = SFSafariViewController(url: url)
        controller.delegate = self
        controller.dismissButtonStyle = .close
        // The view renders out of process, so the colours are resolved against
        // the app's appearance now rather than handed over as dynamic colours.
        let traits = presenter.traitCollection
        controller.preferredBarTintColor =
          WildflowerColor.colorBackground.resolvedColor(with: traits)
        controller.preferredControlTintColor =
          WildflowerColor.colorNeutral1.resolvedColor(with: traits)
        // Default presentation: SFSafariViewController brings its own push-style
        // transition (slides in from the right, edge swipe to go back). If a
        // device shows it as a sheet instead, set `modalPresentationStyle` here.
        self.showing = ShowingPage(controller: controller, events: args.events)
        presenter.present(controller, animated: true)
        invoke.resolve()
      }
    }
  }

  /// The user closed the view (Close button or edge swipe).
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    guard let page = showing, page.controller === controller else { return }
    showing = nil
    Self.reportClosed(page)
  }

  /// Dismiss the showing view, report its close, then run `next`. Runs `next`
  /// straight away when nothing is showing.
  private func dismissShowing(then next: @escaping () -> Void) {
    guard let page = showing else {
      next()
      return
    }
    showing = nil
    // Dismissing from the presenter also takes down anything the view itself
    // presented (a share sheet). A view that is no longer presented has nothing
    // to dismiss, and `dismiss` would never call its completion.
    guard let presenter = page.controller.presentingViewController else {
      Self.reportClosed(page)
      next()
      return
    }
    presenter.dismiss(animated: true) {
      Self.reportClosed(page)
      next()
    }
  }

  private static func reportClosed(_ page: ShowingPage) {
    // Lowercase tag matches `models.rs`; `JsonObject` pins the non-throwing send overload.
    let data: JsonObject = ["event": "closed"]
    page.events.send(data)
  }

  /// The top-most view controller above Tauri's root, to present from — a native
  /// webview sheet may be up over the root.
  private func topViewController() -> UIViewController? {
    var top = manager.viewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

/// App palette as dynamic colors that resolve per the OS light/dark appearance.
/// Same tokens and values as `tauri-plugin-native-webview`'s `WildflowerColor`
/// and the web app's `--color-background` / `--color-neutral-1`; redefined here
/// because native code can't read the web app's CSS.
enum WildflowerColor {
  static let colorBackground = dynamic(light: 0xF7_EC_DD, dark: 0x22_1B_16)
  static let colorNeutral1 = dynamic(light: 0x2C_21_1D, dark: 0xF3_E9_DB)

  /// A `UIColor` that picks `light` or `dark` (each an `0xRRGGBB` literal) from
  /// the resolving trait collection.
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

/// Entry point Tauri's `ios_plugin_binding!(init_plugin_native_page_browser)`
/// links against; returns the plugin instance Tauri drives.
@_cdecl("init_plugin_native_page_browser")
func initPlugin() -> Plugin {
  return NativePageBrowserPlugin()
}
