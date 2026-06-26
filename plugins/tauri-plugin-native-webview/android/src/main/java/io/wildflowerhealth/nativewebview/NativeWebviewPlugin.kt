package io.wildflowerhealth.nativewebview

import android.app.Activity
import android.app.Dialog
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
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
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.ScriptHandler
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
 * Arguments decoded from `invoke('plugin:native-webview|open_url', { url, initScript, nativeWebviewEventChannel })`.
 * `nativeWebviewEventChannel` is a Tauri `Channel<NativeWebviewEvent>` the caller receives
 * native webview events on (`{"event":"message", "payload": …}` / `{"event":"hidden"}` /
 * `{"event":"disposed"}`) — matches the `models.rs` `NativeWebviewEvent` serde shape.
 */
@InvokeArg
class OpenArgs {
    lateinit var url: String
    var initScript: String? = null
    lateinit var nativeWebviewEventChannel: Channel

    // Chrome applied at presentation time (absent = null = leave unchanged).
    // Matches `OpenRequest`'s `initialTitle` / `initialSubtitle` /
    // `initialMessage` camelCase wire shape.
    var initialTitle: String? = null
    var initialSubtitle: String? = null
    var initialMessage: String? = null
}

/**
 * Arguments decoded from `invoke('plugin:native-webview|evaluate_js', { script })`.
 * Keys match `EvaluateJsRequest`'s camelCase serde wire shape. The host evaluates
 * `script` verbatim in the native webview — typically a
 * `window.__nativeWebviewReceive(JSON.stringify(...))` call carrying a bridge
 * envelope.
 */
@InvokeArg
class EvaluateJsArgs {
    lateinit var script: String
}

/**
 * Arguments decoded from `invoke('plugin:native-webview|patch_window_text', { title?, subtitle?, message? })`.
 * Each field is optional: `null` / absent = leave unchanged; empty string
 * clears that label. Matches `PatchWindowTextRequest`'s camelCase serde wire shape.
 */
@InvokeArg
class PatchWindowTextArgs {
    var title: String? = null
    var subtitle: String? = null
    var message: String? = null
}

/**
 * Android counterpart to the iOS `NativeWebviewPlugin`. Hosts an
 * `android.webkit.WebView` in a fullscreen `Dialog` with a native `Toolbar`,
 * injecting the caller's document-start script on any origin and forwarding the
 * page's opaque JSON messages to the host webview via the plugin event channel.
 *
 * The cross-platform lifecycle/race protocols this backend implements are
 * documented once in docs/Lifecycle and Races Explanation.md; the inline comments below
 * point at its sections rather than re-deriving them per platform.
 */
@TauriPlugin
class NativeWebviewPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        /** `window.<name>` the injected bridge posts to (a `@JavascriptInterface`). */
        private const val MESSAGE_HANDLER_NAME = "nativeWebview"

        /** Menu item id for the top-toolbar Refresh action. */
        private const val MENU_ITEM_REFRESH = 1

        /** Teardown backstop — see docs/Lifecycle and Races Explanation.md § "Teardown backstops" (mobile 5-min idle). */
        private const val IDLE_TEARDOWN_MS = 5L * 60L * 1000L

        // App palette as 0xAARRGGBB ints, one pair per token. Same tokens as the
        // web app's --color-background / --color-neutral-1 / --color-neutral-4
        // (named to match for clear relatedness); the matching value is picked at
        // present() time from the current night-mode configuration.
        private const val COLOR_BACKGROUND_LIGHT = 0xFFF7ECDD.toInt()
        private const val COLOR_BACKGROUND_DARK = 0xFF221B16.toInt()
        private const val COLOR_NEUTRAL_1_LIGHT = 0xFF2C211D.toInt()
        private const val COLOR_NEUTRAL_1_DARK = 0xFFF3E9DB.toInt()
        private const val COLOR_NEUTRAL_4_LIGHT = 0xFF6C5B50.toInt()
        private const val COLOR_NEUTRAL_4_DARK = 0xFFB3A294.toInt()
    }

    /** The current native webview's `Dialog`, if any. Held across a hide so the same live instance can be re-presented. */
    private var dialog: Dialog? = null

    /**
     * Whether the current native webview is presently on screen. Tracked
     * explicitly because a hidden instance is kept alive — see
     * docs/Lifecycle and Races Explanation.md § "Visibility, liveness, and existence are independent"
     * ([Dialog.isShowing] conflates visibility with existence).
     */
    private var isVisible = false

    /**
     * The current native webview, if any. Captured on `openUrl`; held across a
     * hide and cleared only on dispose, so `evaluateJs` rejects after teardown.
     */
    private var currentWebView: WebView? = null

    /** Top toolbar of the current native webview, if any. Captured so `patchWindowText` can set its title/subtitle without re-walking the view tree. Cleared on dismiss. */
    private var currentToolbar: Toolbar? = null

    /** Bottom-bar message label of the current native webview, if any. Captured so `patchWindowText` can push status text without re-walking the view tree. */
    private var currentMessageView: TextView? = null

    /**
     * Chrome URL-fallback state — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback".
     * [currentUrl] tracks the live page URL (updated via [onNavigate]);
     * [titleClaimed] / [subtitleClaimed] flip true once the caller supplies that
     * field. All three reset per open ([present] or an in-place re-wire).
     */
    private var currentUrl: String = ""
    private var titleClaimed = false
    private var subtitleClaimed = false

    /** The current native webview's JS-bridge. Captured so a re-open can rebind `bridge.channel` without rebuilding the WebView. Cleared on dismiss. */
    private var currentBridge: Bridge? = null

    /**
     * Handle for the WebView's installed document-start script, when the provider
     * supports `DOCUMENT_START_SCRIPT`. Retained so a re-open can
     * [ScriptHandler.remove] the prior script before adding the new one — see
     * docs/Lifecycle and Races Explanation.md § "Re-open rewire". Cleared on dismiss.
     */
    private var currentDocStartScript: ScriptHandler? = null

    /**
     * Switch-demo race guard — see docs/Lifecycle and Races Explanation.md § "The dispose→open \"switch-demo\" race".
     * Set in [disposeDialog] before the dispose [Dialog.dismiss], cleared in the
     * dispose's `setOnDismissListener`; covers the gap during which
     * `Dialog.dismiss()` has only enqueued teardown. Set ONLY by a dispose, never
     * by a [hide].
     */
    private var isDisposing = false

    /** Deferred replay closure for the switch-demo race — see docs/Lifecycle and Races Explanation.md § "The dispose→open \"switch-demo\" race". Last-write-wins. */
    private var onDisposeFinishedHandler: (() -> Unit)? = null

    /** The [Invoke] owned by [onDisposeFinishedHandler], held separately so a superseding `openUrl()` can reject it — see docs/Lifecycle and Races Explanation.md § "The dispose→open \"switch-demo\" race". */
    private var pendingInvoke: Invoke? = null

    /** Main-looper handler the idle teardown backstop posts on (keeps teardown on the UI thread). See [idleTeardownRunnable]. */
    private val idleHandler = Handler(Looper.getMainLooper())

    /** An instance exists but is off screen — the only state the idle backstop reclaims. */
    private val hasHiddenInstance: Boolean
        get() = dialog != null && !isVisible

    /**
     * Teardown backstop action — see docs/Lifecycle and Races Explanation.md § "Teardown backstops".
     * Auto-`dispose`s the instance after [IDLE_TEARDOWN_MS] hidden + idle; guards
     * on [hasHiddenInstance] so a `show`/`dispose` that landed first is a no-op.
     */
    private val idleTeardownRunnable = Runnable {
        if (hasHiddenInstance) {
            disposeDialog()
        }
    }

    /**
     * Ensure a native webview exists and navigate it to `url`. Builds the
     * WebView + its (not-yet-shown) `Dialog` if absent; on an existing instance
     * (visible OR hidden) re-wires and navigates in place, PRESERVING current
     * visibility. Never shows the dialog — call [show] to present it. Resolves
     * with `{opened: true}`.
     */
    @Command
    fun openUrl(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            resetIdleTimer() // a command counts as activity
            // Dispose in flight — queue a deferred replay rather than rewiring a
            // doomed WebView. See docs/Lifecycle and Races Explanation.md § "The dispose→open
            // \"switch-demo\" race".
            if (isDisposing) {
                // Supersede any already-queued openUrl: reject its invoke so its
                // promise doesn't hang (last-write-wins would drop its `resolve`).
                pendingInvoke?.reject(
                    "native-webview: superseded by a newer open() before the popup finished closing"
                )
                pendingInvoke = invoke
                onDisposeFinishedHandler = {
                    present(
                        args.url,
                        args.initScript,
                        args.nativeWebviewEventChannel,
                        args.initialTitle,
                        args.initialSubtitle,
                        args.initialMessage,
                    )
                    val result = JSObject()
                    result.put("opened", true)
                    invoke.resolve(result)
                }
                return@runOnUiThread
            }
            val existing = currentWebView
            val bridge = currentBridge
            val d = dialog
            // Existing instance, not being disposed: rewire it in place — see
            // docs/Lifecycle and Races Explanation.md § "Re-open rewire". (Visibility is
            // preserved; we do NOT show here.)
            if (existing != null && bridge != null && d != null) {
                bridge.channel = args.nativeWebviewEventChannel
                args.initScript?.let { script ->
                    existing.evaluateJavascript(script, null)
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        // Remove the prior document-start script before adding the
                        // new one so repeated re-wires don't stack copies.
                        currentDocStartScript?.remove()
                        currentDocStartScript =
                            WebViewCompat.addDocumentStartJavaScript(existing, script, setOf("*"))
                    }
                }

                // A re-wire is logically a fresh open: reset the URL-fallback
                // claim state and clear the message, then re-apply initial chrome.
                currentUrl = args.url
                titleClaimed = false
                subtitleClaimed = false
                currentMessageView?.text = null
                applyWindowText(
                    args.initialTitle,
                    args.initialSubtitle,
                    args.initialMessage,
                )
                existing.loadUrl(args.url)
            } else {
                present(
                    args.url,
                    args.initScript,
                    args.nativeWebviewEventChannel,
                    args.initialTitle,
                    args.initialSubtitle,
                    args.initialMessage,
                )
            }
            val result = JSObject()
            result.put("opened", true)
            invoke.resolve(result)
        }
    }

    /**
     * Evaluate JS inside the current native webview. Rejects if no native webview
     * exists (caller should `await invoke('plugin:native-webview|open_url', …)`
     * first). The evaluation itself is asynchronous and best-effort — its return
     * value and any thrown JS error are not surfaced.
     */
    @Command
    fun evaluateJs(invoke: Invoke) {
        val args = invoke.parseArgs(EvaluateJsArgs::class.java)
        activity.runOnUiThread {
            resetIdleTimer() // a command counts as activity
            val webView = currentWebView
            if (webView == null) {
                invoke.reject("native-webview: no native webview open")
                return@runOnUiThread
            }
            webView.evaluateJavascript(args.script, null)
            val result = JSObject()
            result.put("wasDispatched", true)
            invoke.resolve(result)
        }
    }

    /**
     * Update one or more of the native webview chrome's three labels
     * (`title`, `subtitle`, `message`). Each field is independently
     * optional: `null` / absent = leave unchanged; empty string clears.
     * Resolves with `{set: true}` once applied. Resolves with `{set: false}`
     * (not a reject) when no native webview is open, so the caller can push
     * speculatively across the native webview lifecycle without retry plumbing.
     */
    @Command
    fun patchWindowText(invoke: Invoke) {
        val args = invoke.parseArgs(PatchWindowTextArgs::class.java)
        activity.runOnUiThread {
            resetIdleTimer() // a command counts as activity
            val toolbar = currentToolbar
            val messageView = currentMessageView
            if (toolbar == null || messageView == null) {
                val result = JSObject()
                result.put("set", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            // Chrome URL-fallback — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback" (null = unchanged; any value, incl. "", claims the slot).
            applyWindowText(args.title, args.subtitle, args.message)
            val result = JSObject()
            result.put("set", true)
            invoke.resolve(result)
        }
    }

    /**
     * Present the native webview — bring a freshly-built or previously-hidden
     * instance to the foreground (`dialog.show()`). Resolves with
     * `{requestCausedShow: true}` only when this call actually presented it;
     * `{requestCausedShow: false}` when no instance exists or it was already
     * visible (a transition flag, matching `hide` / `dispose`). Cancels the
     * idle teardown backstop (a visible webview is never idle-reclaimed).
     */
    @Command
    fun show(invoke: Invoke) {
        activity.runOnUiThread {
            cancelIdleTimer()
            // Dispose teardown in flight — nothing presentable; showing the doomed
            // dialog would be a use-after-destroy. See docs/Lifecycle and Races Explanation.md
            // § "The dispose→open \"switch-demo\" race".
            if (isDisposing) {
                val result = JSObject()
                result.put("requestCausedShow", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            val d = dialog
            if (d == null) {
                val result = JSObject()
                result.put("requestCausedShow", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            if (isVisible) {
                // Already on screen — no transition caused, so report `false`.
                val result = JSObject()
                result.put("requestCausedShow", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            d.show()
            isVisible = true
            val result = JSObject()
            result.put("requestCausedShow", true)
            invoke.resolve(result)
        }
    }

    /**
     * Hide the native webview — remove it from view but keep it alive and
     * running. Routes through [hideDialog]. See docs/Lifecycle and Races Explanation.md
     * § "User dismissal hides; only `dispose` tears down". Resolves with
     * `{requestCausedHide: false}` when nothing was visible, `true` once hidden.
     */
    @Command
    fun hide(invoke: Invoke) {
        activity.runOnUiThread {
            resetIdleTimer()
            val d = dialog
            if (d == null || !isVisible) {
                val result = JSObject()
                result.put("requestCausedHide", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            hideDialog()
            val result = JSObject()
            result.put("requestCausedHide", true)
            invoke.resolve(result)
        }
    }

    /**
     * Dispose the native webview — tear it down and free its resources (the
     * `Dialog`, the `WebView`, and its `@JavascriptInterface`). Routes through
     * [disposeDialog]; the dispose's `setOnDismissListener` emits
     * `NativeWebviewEvent::Disposed`. See docs/Lifecycle and Races Explanation.md
     * § "User dismissal hides; only `dispose` tears down". Resolves with
     * `{requestCausedDispose: false}` when none existed, `true` once torn down.
     */
    @Command
    fun dispose(invoke: Invoke) {
        activity.runOnUiThread {
            cancelIdleTimer()
            val d = dialog
            if (d == null) {
                val result = JSObject()
                result.put("requestCausedDispose", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            disposeDialog()
            val result = JSObject()
            result.put("requestCausedDispose", true)
            invoke.resolve(result)
        }
    }

    /**
     * Remove the native webview from view while keeping it alive — the shared
     * landing point for a host [hide] and a USER dismissal (Toolbar Close /
     * system back). See docs/Lifecycle and Races Explanation.md § "User dismissal hides;
     * only `dispose` tears down". Android mechanism: `dialog.hide()` does NOT
     * fire `setOnDismissListener` (only `dismiss()` does), so nothing is torn
     * down. Emits `Hidden` on the latest channel and arms the idle backstop.
     */
    private fun hideDialog() {
        val d = dialog ?: return
        if (!isVisible) return
        d.hide()
        isVisible = false
        // Emit `Hidden` on the latest (possibly re-wired) channel.
        currentBridge?.let { bridge ->
            val payload = JSObject()
            payload.put("event", "hidden")
            bridge.channel.send(payload)
        }
        resetIdleTimer() // hidden now — start the idle backstop counting down
    }

    /**
     * Tear the native webview down — the single teardown path for host `dispose`
     * and the idle backstop. Sets [isDisposing] (the switch-demo race guard) then
     * `dialog.dismiss()`, whose `setOnDismissListener` does the actual WebView
     * teardown + `Disposed` emit. See docs/Lifecycle and Races Explanation.md
     * § "The dispose→open \"switch-demo\" race". Android mechanism: `dismiss()`
     * fires the listener even for a hidden (not-dismissed) dialog, so a dispose
     * of a hidden instance still tears down.
     */
    private fun disposeDialog() {
        val d = dialog ?: return
        cancelIdleTimer()
        isDisposing = true
        d.dismiss()
    }

    /**
     * (Re)arm the idle teardown backstop to fire [IDLE_TEARDOWN_MS] from now,
     * but only while hidden. Called on every activity (inbound bridge message or
     * any command). See docs/Lifecycle and Races Explanation.md § "Teardown backstops".
     */
    private fun resetIdleTimer() {
        idleHandler.removeCallbacks(idleTeardownRunnable)
        if (hasHiddenInstance) {
            idleHandler.postDelayed(idleTeardownRunnable, IDLE_TEARDOWN_MS)
        }
    }

    /** Cancel the idle teardown backstop (instance shown or disposed). */
    private fun cancelIdleTimer() {
        idleHandler.removeCallbacks(idleTeardownRunnable)
    }

    /**
     * Apply caller-supplied window text and re-paint the URL fallback — see
     * docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback". `null` = leave
     * unchanged; any present value (incl. `""`) claims that slot. Shared by
     * `openUrl`'s initial chrome, `patchWindowText`, and the re-wire path.
     */
    private fun applyWindowText(title: String?, subtitle: String?, message: String?) {
        title?.let {
            titleClaimed = true
            currentToolbar?.title = it.ifEmpty { null }
        }
        subtitle?.let {
            subtitleClaimed = true
            currentToolbar?.subtitle = it.ifEmpty { null }
        }
        message?.let { currentMessageView?.text = it.ifEmpty { null } }
        renderUrlFallback()
    }

    /** Paint [currentUrl] into the highest unclaimed slot — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback". Claimed slots are never overwritten here. */
    private fun renderUrlFallback() {
        if (!titleClaimed) {
            currentToolbar?.title = currentUrl.ifEmpty { null }
        } else if (!subtitleClaimed) {
            currentToolbar?.subtitle = currentUrl.ifEmpty { null }
        }
    }

    /** Sync the URL fallback to a navigation (called from `onPageStarted`) — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback". */
    private fun onNavigate(newUrl: String) {
        currentUrl = newUrl
        renderUrlFallback()
    }

    private fun present(
        url: String,
        initScript: String?,
        channel: Channel,
        initialTitle: String?,
        initialSubtitle: String?,
        initialMessage: String?,
    ) {
        val webView = WebView(activity)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        currentWebView = webView

        // Reset the URL-fallback state for this fresh native webview.
        currentUrl = url
        titleClaimed = false
        subtitleClaimed = false

        val bridge = Bridge(channel)
        webView.addJavascriptInterface(bridge, MESSAGE_HANDLER_NAME)
        currentBridge = bridge
        bridge.onActivity = { resetIdleTimer() } // inbound traffic is activity

        // Caller-supplied document-start script (e.g. browser-sniffer's bundled
        // installSniffer IIFE), injected on ANY origin when the WebView provider
        // supports DOCUMENT_START_SCRIPT; an onPageStarted fallback (below)
        // otherwise — note the fallback is not strictly before the page's scripts.
        val supportsDocumentStart =
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (initScript != null && supportsDocumentStart) {
            // Retain the handle so a later re-wire can remove this script
            // before adding its replacement.
            currentDocStartScript =
                WebViewCompat.addDocumentStartJavaScript(webView, initScript, setOf("*"))
        } else if (initScript != null) {
            // The `onPageStarted` fallback fires AFTER the JS context exists, so a
            // page's inline `<head>` `<script>` that synchronously calls
            // `fetch`/`XMLHttpRequest` runs before our injection — those requests
            // escape interception silently. Log it so an out-of-date device
            // (pre-WebView-83, no DOCUMENT_START_SCRIPT) surfaces rather than just
            // producing thin data.
            android.util.Log.w(
                "NativeWebview",
                "WebViewFeature.DOCUMENT_START_SCRIPT unsupported on this device's " +
                    "WebView provider; falling back to onPageStarted injection. Early " +
                    "synchronous fetch/XHR from inline scripts will NOT be intercepted. " +
                    "Update Android System WebView (requires version 83+) to restore " +
                    "full coverage."
            )
        }

        // Resolve the app palette for the current OS appearance (light / dark).
        val night =
            (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES
        val colorBackground = if (night) COLOR_BACKGROUND_DARK else COLOR_BACKGROUND_LIGHT
        val colorNeutral1 = if (night) COLOR_NEUTRAL_1_DARK else COLOR_NEUTRAL_1_LIGHT
        val colorNeutral4 = if (night) COLOR_NEUTRAL_4_DARK else COLOR_NEUTRAL_4_LIGHT

        val toolbar = Toolbar(activity).apply {
            // Title/subtitle text is driven by the URL-fallback state machine
            // (applied via `applyWindowText` below), not set here.
            setTitleTextColor(colorNeutral1)
            setSubtitleTextColor(colorNeutral4)
            setBackgroundColor(colorBackground)
            navigationIcon =
                activity.getDrawable(R.drawable.nwv_ic_close)
                    ?.apply { setTint(colorNeutral1) }
            // Toolbar Close is a USER dismissal — HIDE, not teardown. See
            // docs/Lifecycle and Races Explanation.md § "User dismissal hides; only `dispose` tears down".
            setNavigationOnClickListener { hideDialog() }
            // Refresh action on the top-right. `OnMenuItemClickListener` fires
            // for any menu item; we dispatch by id rather than collecting per
            // item so the toolbar.menu surface can grow without re-plumbing.
            menu.add(0, MENU_ITEM_REFRESH, 0, "Refresh").apply {
                icon = activity.getDrawable(R.drawable.nwv_ic_refresh)
                    ?.apply { setTint(colorNeutral1) }
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
            setImageDrawable(activity.getDrawable(R.drawable.nwv_ic_chevron_left))
            setColorFilter(colorNeutral1)
            background = null
            contentDescription = "Back"
            setOnClickListener { if (webView.canGoBack()) webView.goBack() }
            isEnabled = false
        }
        val forwardButton = ImageButton(activity).apply {
            setImageDrawable(activity.getDrawable(R.drawable.nwv_ic_chevron_right))
            setColorFilter(colorNeutral1)
            background = null
            contentDescription = "Forward"
            setOnClickListener { if (webView.canGoForward()) webView.goForward() }
            isEnabled = false
        }
        // Caller-controlled message label, placed next to the nav arrows for
        // status text (e.g. "34 resources collected"). The plugin doesn't
        // touch its contents — `patchWindowText` is the only writer.
        val messageView = TextView(activity).apply {
            setTextColor(colorNeutral4)
            textSize = 13f
            setPadding(16, 0, 0, 0)
            ellipsize = android.text.TextUtils.TruncateAt.END
            maxLines = 1
        }
        currentMessageView = messageView

        // Apply caller-supplied initial chrome before the dialog shows so the bar
        // is correct on first paint — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback".
        applyWindowText(initialTitle, initialSubtitle, initialMessage)

        val bottomBar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setBackgroundColor(colorBackground)
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
                // Keep the URL fallback in sync with navigation (at commit time,
                // matching desktop) — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback".
                pageUrl?.let { onNavigate(it) }
            }

            override fun onPageFinished(view: WebView, pageUrl: String?) {
                // Refresh the polled nav-arrow enabled state (see the bottom-bar
                // setup above); `onPageFinished` is the hook every navigation hits.
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
            // System back: navigate WebView history when there is one, else HIDE
            // (see below) — without this hook the Dialog's default back tears the
            // native webview down. Matches the in-toolbar Back button.
            //
            // Listen on ACTION_UP (not DOWN) so the consumed event matches the
            // system's own dispatch — handling DOWN can leave a stranded
            // ACTION_UP that triggers other listeners.
            setOnKeyListener { _, keyCode, event ->
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    if (webView.canGoBack()) {
                        webView.goBack()
                        true
                    } else {
                        // System back at the root of history is a USER dismissal —
                        // HIDE, not teardown. See docs/Lifecycle and Races Explanation.md
                        // § "User dismissal hides; only `dispose` tears down".
                        hideDialog()
                        true
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
            // The unconditional teardown path: `dismiss()` fires this ONLY from a
            // [disposeDialog] — [hideDialog]'s `dialog.hide()` does not. Free the
            // WebView and emit `disposed`. See docs/Lifecycle and Races Explanation.md
            // § "User dismissal hides; only `dispose` tears down".
            setOnDismissListener {
                // Read the latest (possibly rewired) channel BEFORE dropping the
                // bridge so the `disposed` echo follows a re-open to its newest
                // caller — see docs/Lifecycle and Races Explanation.md § "Re-open rewire".
                val disposeChannel = currentBridge?.channel ?: channel
                // Tear down THIS dialog's WebView (the `webView` local captured at
                // present() time) so a dispose doesn't leak a fully-loaded WebView,
                // its `@JavascriptInterface` (which pins Bridge → plugin →
                // Activity), and its still-live JS/render thread.
                webView.stopLoading()
                webView.removeJavascriptInterface(MESSAGE_HANDLER_NAME)
                (webView.parent as? ViewGroup)?.removeView(webView)
                webView.destroy()
                cancelIdleTimer()
                dialog = null
                isVisible = false
                currentWebView = null
                currentToolbar = null
                currentMessageView = null
                currentBridge = null
                currentDocStartScript = null
                isDisposing = false
                // If `openUrl()` queued a replay during the dispose, run it and
                // skip the `disposed` echo; otherwise emit `disposed`. See
                // docs/Lifecycle and Races Explanation.md § "The dispose→open \"switch-demo\" race".
                val pending = onDisposeFinishedHandler
                onDisposeFinishedHandler = null
                if (pending != null) {
                    pendingInvoke = null
                    pending()
                } else {
                    // NativeWebviewEvent.disposed (lowercase tag) — matches the `models.rs` shape.
                    val payload = JSObject()
                    payload.put("event", "disposed")
                    disposeChannel.send(payload)
                }
            }
            // Build HIDDEN — do NOT call `show()` here (`show` presents it later).
        }
        // Arm the idle backstop so a built-but-never-shown instance is reclaimed.
        isVisible = false
        resetIdleTimer()
    }

    /**
     * Activity-destroy teardown backstop — see docs/Lifecycle and Races Explanation.md
     * § "Teardown backstops". When the host Activity is destroyed with an
     * instance still alive, dispose it so it doesn't leak and the host still sees
     * a terminal `disposed`. Mirrors the iOS controller-`deinit` backstop;
     * `disposeDialog`'s `dialog.dismiss()` runs the teardown synchronously here.
     */
    override fun onDestroy(activity: AppCompatActivity) {
        if (dialog != null) {
            disposeDialog()
        }
        super.onDestroy(activity)
    }

    /**
     * JS -> native bridge surface exposed as `window.nativeWebview`. Each native
     * webview gets its own `Bridge` so events route to the matching caller's
     * channel. `channel` is `var` so a re-open can swap it without rebuilding the
     * WebView (see docs/Lifecycle and Races Explanation.md § "Re-open rewire"); [onActivity]
     * resets the idle teardown backstop (§ "Teardown backstops").
     */
    inner class Bridge(var channel: Channel) {
        /** Called on every inbound message so the plugin resets the idle timer. */
        var onActivity: (() -> Unit)? = null

        @JavascriptInterface
        fun postMessage(json: String) {
            // The injected adapter posts an opaque JSON string (the sniffer's
            // wire message). Forward it verbatim through the caller's channel
            // as a `NativeWebviewEvent.message` (matches `models.rs` `NativeWebviewEvent`).
            val payload = JSObject()
            payload.put("event", "message")
            payload.put("payload", json)
            // Snapshot the channel at post time so a concurrent re-open rewire
            // doesn't reroute an in-flight message (see § "Re-open rewire").
            val initializedChannel = channel
            // `Channel.send` routes over JNI to the Rust channel handler and does
            // NOT touch the host WebView, so it's safe on this binder thread.
            // Keeping it off the UI looper matters on the streaming hot path: a
            // fast EHR stream posts hundreds of chunks/sec, and routing each
            // through the main looper would serialize all bridge traffic behind
            // pending UI work (iOS doesn't hop — its handler is already
            // main-thread). Posts arrive in call order, so FIFO is preserved.
            initializedChannel.send(payload)
            // Only the idle-timer reset needs the UI thread (it reads UI-owned
            // `dialog`/`isVisible`); inbound traffic counts as activity.
            activity.runOnUiThread {
                onActivity?.invoke()
            }
        }
    }
}
