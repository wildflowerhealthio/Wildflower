package com.plugin.nativewebview

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.view.Gravity
import android.view.KeyEvent
import android.view.MenuItem
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toolbar
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Arguments decoded from `invoke('plugin:native-webview|open', { url, initScript, channel })`.
 * `channel` is a Tauri `Channel<PopupEvent>` the caller receives popup events on
 * (`{"event":"message", "payload": …}` / `{"event":"closed"}`) — matches the
 * `models.rs` `PopupEvent` serde shape.
 */
@InvokeArg
class OpenArgs {
    lateinit var url: String
    var initScript: String? = null
    lateinit var channel: Channel
}

/**
 * Arguments decoded from `invoke('plugin:native-webview|send', { script })`.
 * Keys match `SendRequest`'s camelCase serde wire shape. The host evaluates
 * `script` verbatim in the popup WebView — typically a
 * `window.__nativeWebviewReceive(JSON.stringify(...))` call carrying a bridge
 * envelope.
 */
@InvokeArg
class SendArgs {
    lateinit var script: String
}

/**
 * Arguments decoded from `invoke('plugin:native-webview|setChrome', { title?, subtitle?, message? })`.
 * Each field is optional: `null` / absent = leave unchanged; empty string
 * clears that label. Matches `SetChromeRequest`'s camelCase serde wire shape.
 */
@InvokeArg
class SetChromeArgs {
    var title: String? = null
    var subtitle: String? = null
    var message: String? = null
}

/**
 * Android counterpart to the iOS `NativeWebviewPlugin`. Presents an
 * `android.webkit.WebView` in a fullscreen `Dialog` with a native `Toolbar`
 * (Close + page host), injecting the caller's document-start script on any
 * origin and forwarding the page's opaque JSON messages to the host webview via
 * the plugin event channel.
 */
@TauriPlugin
class NativeWebviewPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        /** `window.<name>` the injected bridge posts to (a `@JavascriptInterface`). */
        private const val MESSAGE_HANDLER_NAME = "nativeWebview"

        /** Menu item id for the top-toolbar Refresh action. */
        private const val MENU_ITEM_REFRESH = 1
    }

    private var dialog: Dialog? = null

    /**
     * The currently-presented popup WebView, if any. Captured on `open` so
     * `send` can `evaluateJavascript(...)` into it; cleared on dismiss so
     * `send` fails loudly with a "no popup open" reject after the user has
     * closed the popup.
     */
    private var currentWebView: WebView? = null

    /**
     * Top toolbar of the current popup, if any. Captured so `setChrome` can
     * update `title` and `subtitle` via `toolbar.title = …` / `toolbar.subtitle = …`
     * without re-walking the dialog's view tree. Cleared alongside
     * `currentWebView` on dismiss.
     */
    private var currentToolbar: Toolbar? = null

    /**
     * Bottom-bar message label of the current popup, if any. Captured so
     * `setChrome` can push status text (e.g. "34 resources collected") next
     * to the navigation arrows without re-walking the view tree.
     */
    private var currentMessageView: TextView? = null

    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            // Already presented: navigate in-place rather than stacking
            // another Dialog. The `DOCUMENT_START_SCRIPT` (or its
            // `onPageStarted` fallback) re-fires on the new navigation, so
            // the caller's `initScript` keeps running for the new page; the
            // per-popup `Bridge` and its captured `Channel` stay wired.
            // A different `initScript` / `channel` on this second call is
            // silently ignored — for browser-sniffer's case both are stable
            // across opens.
            val existing = currentWebView
            if (existing != null) {
                existing.loadUrl(args.url)
            } else {
                present(args.url, args.initScript, args.channel)
            }
            val result = JSObject()
            result.put("opened", true)
            invoke.resolve(result)
        }
    }

    /**
     * Evaluate JS inside the currently-presented popup WebView. Rejects if no
     * popup is open (caller should `await invoke('plugin:native-webview|open',
     * …)` first). The evaluation itself is asynchronous and best-effort — its
     * return value and any thrown JS error are not surfaced.
     */
    @Command
    fun send(invoke: Invoke) {
        val args = invoke.parseArgs(SendArgs::class.java)
        activity.runOnUiThread {
            val webView = currentWebView
            if (webView == null) {
                invoke.reject("native-webview: no popup open")
                return@runOnUiThread
            }
            webView.evaluateJavascript(args.script, null)
            val result = JSObject()
            result.put("sent", true)
            invoke.resolve(result)
        }
    }

    /**
     * Update one or more of the popup chrome's three labels
     * (`title`, `subtitle`, `message`). Each field is independently
     * optional: `null` / absent = leave unchanged; empty string clears.
     * Resolves with `{set: true}` once applied. Resolves with `{set: false}`
     * (not a reject) when no popup is open, so the caller can push
     * speculatively across the popup lifecycle without retry plumbing.
     */
    @Command
    fun setChrome(invoke: Invoke) {
        val args = invoke.parseArgs(SetChromeArgs::class.java)
        activity.runOnUiThread {
            val toolbar = currentToolbar
            val messageView = currentMessageView
            if (toolbar == null || messageView == null) {
                val result = JSObject()
                result.put("set", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            args.title?.let { toolbar.title = if (it.isEmpty()) null else it }
            args.subtitle?.let { toolbar.subtitle = if (it.isEmpty()) null else it }
            args.message?.let { messageView.text = if (it.isEmpty()) null else it }
            val result = JSObject()
            result.put("set", true)
            invoke.resolve(result)
        }
    }

    /**
     * Dismiss the currently-presented popup. Idempotent — resolves with
     * `{closed: false}` when no popup is open. `Dialog.dismiss()` triggers
     * the `setOnDismissListener` that fires `PopupEvent::Closed` through
     * the channel, so the host-initiated dismissal raises the same event
     * the user-initiated chrome Close button does.
     */
    @Command
    fun close(invoke: Invoke) {
        activity.runOnUiThread {
            val d = dialog
            if (d == null || !d.isShowing) {
                val result = JSObject()
                result.put("closed", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            d.dismiss()
            val result = JSObject()
            result.put("closed", true)
            invoke.resolve(result)
        }
    }

    private fun present(url: String, initScript: String?, channel: Channel) {
        val webView = WebView(activity)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        // Capture so `send` can target it; cleared on dismiss below.
        currentWebView = webView

        // JS -> native bridge, reachable on any origin. Per-popup so a stacked
        // second `open` doesn't redirect the first popup's events into the
        // second popup's channel.
        webView.addJavascriptInterface(Bridge(channel), MESSAGE_HANDLER_NAME)

        // Caller-supplied document-start script (e.g. browser-sniffer's bundled
        // installSniffer IIFE), injected on ANY origin when the WebView provider
        // supports DOCUMENT_START_SCRIPT; an onPageStarted fallback (below)
        // otherwise — note the fallback is not strictly before the page's scripts.
        val supportsDocumentStart =
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (initScript != null && supportsDocumentStart) {
            WebViewCompat.addDocumentStartJavaScript(webView, initScript, setOf("*"))
        }

        val toolbar = Toolbar(activity).apply {
            title = Uri.parse(url).host ?: url
            setTitleTextColor(Color.WHITE)
            setSubtitleTextColor(Color.parseColor("#A0A4AF"))
            setBackgroundColor(Color.parseColor("#14161C"))
            navigationIcon = activity.getDrawable(android.R.drawable.ic_menu_close_clear_cancel)
            setNavigationOnClickListener { dialog?.dismiss() }
            // Refresh action on the top-right. `OnMenuItemClickListener` fires
            // for any menu item; we dispatch by id rather than collecting per
            // item so the toolbar.menu surface can grow without re-plumbing.
            menu.add(0, MENU_ITEM_REFRESH, 0, "Refresh").apply {
                icon = activity.getDrawable(android.R.drawable.ic_menu_rotate)
                setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
            }
            setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    MENU_ITEM_REFRESH -> {
                        webView.reload()
                        true
                    }
                    else -> false
                }
            }
        }
        currentToolbar = toolbar

        // Bottom bar: Back / Forward on the leading edge. Plain
        // `ImageButton`s in a horizontal `LinearLayout` so we don't need the
        // Material `BottomAppBar`'s CoordinatorLayout setup. Enabled state is
        // driven from the `WebViewClient.onPageFinished` callback below
        // because `android.webkit.WebView` exposes no canGo* observable.
        val backButton = ImageButton(activity).apply {
            setImageDrawable(activity.getDrawable(android.R.drawable.ic_media_previous))
            background = null
            contentDescription = "Back"
            setOnClickListener { if (webView.canGoBack()) webView.goBack() }
            isEnabled = false
        }
        val forwardButton = ImageButton(activity).apply {
            setImageDrawable(activity.getDrawable(android.R.drawable.ic_media_next))
            background = null
            contentDescription = "Forward"
            setOnClickListener { if (webView.canGoForward()) webView.goForward() }
            isEnabled = false
        }
        // Caller-controlled message label, placed next to the nav arrows for
        // status text (e.g. "34 resources collected"). The plugin doesn't
        // touch its contents — `setChrome` is the only writer.
        val messageView = TextView(activity).apply {
            setTextColor(Color.parseColor("#A0A4AF"))
            textSize = 13f
            setPadding(16, 0, 0, 0)
            ellipsize = android.text.TextUtils.TruncateAt.END
            maxLines = 1
        }
        currentMessageView = messageView

        val bottomBar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#14161C"))
            setPadding(8, 8, 8, 8)
            addView(
                backButton,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
            addView(
                forwardButton,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
            // The message takes the remaining horizontal width (weight=1)
            // so longer status strings don't push the nav arrows off-edge.
            addView(
                messageView,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            )
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, pageUrl: String?, favicon: Bitmap?) {
                if (initScript != null && !supportsDocumentStart) {
                    view.evaluateJavascript(initScript, null)
                }
            }

            override fun onPageFinished(view: WebView, pageUrl: String?) {
                // Title is owned by the caller from now on — only refresh
                // the nav-arrow enabled state. `canGoBack` / `canGoForward`
                // are polled methods (no observable equivalent on
                // `android.webkit.WebView`); `onPageFinished` is the
                // standard hook every navigation hits.
                backButton.isEnabled = view.canGoBack()
                forwardButton.isEnabled = view.canGoForward()
            }
        }

        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            addView(
                toolbar,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
            addView(
                webView,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            )
            addView(
                bottomBar,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
        }

        webView.loadUrl(url)

        dialog = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen).apply {
            setContentView(layout)
            // System back: navigate WebView history when there is one, else
            // dismiss. Without this hook the Dialog's default back behaviour
            // dismisses the popup outright — surprising when the sniffer has
            // auto-navigated several pages deep and the user expects "back"
            // to undo the most recent navigation. Matches the in-toolbar
            // Back button's logic so software and hardware back agree.
            //
            // Listening on ACTION_UP (not DOWN) so the consumed event matches
            // the system's own dispatch — handling DOWN can leave a stranded
            // ACTION_UP that triggers other listeners.
            setOnKeyListener { _, keyCode, event ->
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    if (webView.canGoBack()) {
                        webView.goBack()
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
            // The fullscreen theme draws the dialog window edge-to-edge —
            // without an insets-aware pad, the top toolbar collides with the
            // status bar / camera cutout, and the bottom bar with the
            // gesture navigation bar. Opt in to edge-to-edge explicitly
            // (so the inset listener actually fires on API 30+) and apply
            // status-bar + cutout insets to the top toolbar and nav-bar
            // insets to the bottom bar. The WebView keeps its zero padding
            // — its content scrolls under everything but isn't clipped by
            // the chrome bars.
            window?.also { WindowCompat.setDecorFitsSystemWindows(it, false) }
            val bottomBarBasePadding = bottomBar.paddingBottom
            ViewCompat.setOnApplyWindowInsetsListener(layout) { _, insets ->
                val safeArea =
                    insets.getInsets(
                        WindowInsetsCompat.Type.systemBars()
                            or WindowInsetsCompat.Type.displayCutout()
                    )
                toolbar.updatePadding(top = safeArea.top)
                bottomBar.updatePadding(bottom = bottomBarBasePadding + safeArea.bottom)
                // Return the original insets so any descendant listener still
                // sees them (we only consume the top/bottom slice; horizontal
                // safe-area handling is the WebView page's problem).
                insets
            }
            setOnDismissListener {
                currentWebView = null
                currentToolbar = null
                currentMessageView = null
                // PopupEvent.closed (lowercase tag) — matches the `models.rs` shape.
                val payload = JSObject()
                payload.put("event", "closed")
                channel.send(payload)
            }
            show()
        }
    }

    /**
     * JS -> native bridge surface exposed as `window.nativeWebview`. Each popup
     * gets its own `Bridge` so events route to the matching caller's channel.
     */
    inner class Bridge(private val channel: Channel) {
        @JavascriptInterface
        fun postMessage(json: String) {
            // The injected adapter posts an opaque JSON string (the sniffer's
            // wire message). Forward it verbatim through the caller's channel
            // as a `PopupEvent.message` (matches `models.rs` `PopupEvent`).
            val payload = JSObject()
            payload.put("event", "message")
            payload.put("payload", json)
            // `@JavascriptInterface` callbacks run off the UI thread; hop back
            // before sending on the channel.
            activity.runOnUiThread { channel.send(payload) }
        }
    }
}
