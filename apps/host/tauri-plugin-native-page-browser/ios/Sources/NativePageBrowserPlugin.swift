import SafariServices
import Tauri
import UIKit

/// Arguments decoded from
/// `invoke('plugin:native-page-browser|open', { url, view, mode, events })`.
/// Keys match `OpenRequest`'s camelCase serde wire shape (see `models.rs`).
/// `view` is the caller's name for the view, which `close` takes. `events` is a
/// Tauri `Channel<BrowserEvent>` that hears `{"event":"closed"}` once this view
/// is gone.
class OpenArgs: Decodable {
  let url: String
  let view: String
  let mode: OpenMode
  let events: Channel
}

/// How an `open` shows its view beside the views showing. Raw values match
/// `models.rs` `OpenMode`.
enum OpenMode: String, Decodable {
  /// Dismiss the showing views, reporting each one's close, then present.
  case replace
  /// Present over the top-most view, leaving the views showing under it.
  case stack
}

/// Arguments decoded from `invoke('plugin:native-page-browser|close', { view })`.
/// Keys match `CloseRequest`'s wire shape (see `models.rs`).
class CloseArgs: Decodable {
  let view: String
}

/// A view the plugin is showing: the caller's name for it, and the channel its
/// close reports on.
struct ShowingPage {
  let view: String
  let controller: SFSafariViewController
  let events: Channel
}

/// Presents an external URL in `SFSafariViewController`, the system's in-app
/// browser: the app can't script the page or read what's typed into it. A
/// `replace` open dismisses the showing views (reporting each one's close)
/// before presenting the next; a `stack` open presents over the top-most one,
/// which stays under it. `close` dismisses one view and any view presented over
/// it. Every close, by the user, by a replacing `open` or by `close`, sends
/// `{"event":"closed"}` exactly once on that view's channel.
class NativePageBrowserPlugin: Plugin, SFSafariViewControllerDelegate {
  /// The views on screen, bottom first: each presented over the ones before
  /// it. A view leaves the list before its close is reported, so each view
  /// reports once whichever path (Close button, edge swipe, replacing `open`,
  /// `close`) gets there first.
  private var showing: [ShowingPage] = []

  /// Present `url` as `mode` says: after dismissing the showing views, or over
  /// them. Resolves once the presentation has started; rejects while a view is
  /// still animating in or out.
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
      if self.isTransitioning() {
        invoke.reject("native-page-browser: a view is still opening or closing")
        return
      }
      let present: () -> Void = {
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
        self.showing.append(
          ShowingPage(view: args.view, controller: controller, events: args.events))
        presenter.present(controller, animated: true)
        invoke.resolve()
      }
      switch args.mode {
      case .replace:
        self.dismissShowing(from: 0, then: present)
      case .stack:
        present()
      }
    }
  }

  /// Dismiss the view opened under `view` and any view presented over it,
  /// reporting each one's close. Resolves once they are gone, straight away
  /// when no such view shows; rejects while a view is still animating in or out.
  @objc public func close(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CloseArgs.self)

    DispatchQueue.main.async {
      guard let index = self.showing.firstIndex(where: { $0.view == args.view }) else {
        invoke.resolve()
        return
      }
      // As in `open`: a dismiss started mid-transition never completes.
      if self.isTransitioning() {
        invoke.reject("native-page-browser: a view is still opening or closing")
        return
      }
      self.dismissShowing(from: index) {
        invoke.resolve()
      }
    }
  }

  /// The user closed the view (Close button or edge swipe). It is the top-most
  /// of the plugin's, but any above it are gone with it.
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    guard let index = showing.firstIndex(where: { $0.controller === controller }) else { return }
    let closed = showing[index...]
    showing.removeSubrange(index...)
    closed.reversed().forEach(Self.reportClosed)
  }

  /// Dismiss the showing view at `index` and every view presented over it,
  /// report each one's close, top-most first, then run `next`. Runs `next`
  /// straight away when nothing shows from `index` on.
  private func dismissShowing(from index: Int, then next: @escaping () -> Void) {
    guard index < showing.count else {
      next()
      return
    }
    let closing = Array(showing[index...])
    showing.removeSubrange(index...)
    let reportAndContinue: () -> Void = {
      closing.reversed().forEach(Self.reportClosed)
      next()
    }
    // Dismissing from the presenter also takes down everything presented over
    // the view: the plugin's later views, and anything the view itself
    // presented (a share sheet). A view that is no longer presented has
    // nothing to dismiss, and `dismiss` would never call its completion.
    guard let presenter = closing[0].controller.presentingViewController else {
      reportAndContinue()
      return
    }
    presenter.dismiss(animated: true, completion: reportAndContinue)
  }

  private static func reportClosed(_ page: ShowingPage) {
    // Lowercase tag matches `models.rs`; `JsonObject` pins the non-throwing send overload.
    let data: JsonObject = ["event": "closed"]
    page.events.send(data)
  }

  /// Whether the top-most view controller is still animating in or out.
  private func isTransitioning() -> Bool {
    guard let top = topViewController() else { return false }
    return top.isBeingPresented || top.isBeingDismissed
  }

  /// The top-most view controller above Tauri's root, to present from — a native
  /// webview sheet, or a view of this plugin's, may be up over the root.
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
