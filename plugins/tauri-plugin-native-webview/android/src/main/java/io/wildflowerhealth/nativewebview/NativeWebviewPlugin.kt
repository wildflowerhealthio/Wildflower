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
 * `android.webkit.WebView` in a fullscreen `Dialog` with a native `Toolbar`
 * (Close + the page URL as the title, until the caller claims it), injecting
 * the caller's document-start script on any origin and forwarding the page's
 * opaque JSON messages to the host webview via the plugin event channel.
 *
 * Lifecycle (mirrors iOS / desktop): `openUrl` ensures a WebView exists (built
 * with its `Dialog` NOT yet shown if absent) and navigates it; `show` presents
 * the dialog. A USER dismissal (Toolbar Close / system back) HIDES it
 * (`dialog.hide()` — kept alive + running) and emits `hidden`; only an explicit
 * `dispose` (or the teardown backstop) destroys the WebView and emits
 * `disposed`. While hidden, a 5-minute idle timer auto-`dispose`s unless reset
 * by activity (inbound bridge message or any command).
 */
@TauriPlugin
class NativeWebviewPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        /** `window.<name>` the injected bridge posts to (a `@JavascriptInterface`). */
        private const val MESSAGE_HANDLER_NAME = "nativeWebview"

        /** Menu item id for the top-toolbar Refresh action. */
        private const val MENU_ITEM_REFRESH = 1

        /**
         * Hidden-idle teardown backstop: while the native webview is hidden,
         * dispose it if this many milliseconds pass with no activity (no inbound
         * bridge message, no command). Any activity resets the timer (see
         * [resetIdleTimer]).
         */
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

    /**
     * The current native webview's `Dialog`, if any. Built (but not shown) by
     * [present]; presented by [show] (`dialog.show()`); removed from view but
     * KEPT ALIVE by a hide / user dismissal (`dialog.hide()`); destroyed by
     * [dispose] (`dialog.dismiss()` + WebView teardown). Held across a hide so
     * the same live instance can be re-presented.
     */
    private var dialog: Dialog? = null

    /**
     * Whether the current native webview is presently on screen. [openUrl]
     * preserves it (navigates in place); [show] sets it true; a user dismissal
     * and [hide] set it false. Tracked explicitly because a hidden instance is
     * kept alive, so "exists" and "is visible" are independent — unlike the old
     * design where `dialog.isShowing` was the sole liveness signal.
     */
    private var isVisible = false

    /**
     * The current native webview, if any. Captured on `openUrl` so
     * `evaluateJs` can `evaluateJavascript(...)` into it; held across a hide
     * (the WebView keeps running while hidden) and cleared only on dispose, so
     * `evaluateJs` fails loudly with a "no native webview open" reject after the
     * instance is disposed.
     */
    private var currentWebView: WebView? = null

    /**
     * Top toolbar of the current native webview, if any. Captured so `patchWindowText` can
     * update `title` and `subtitle` via `toolbar.title = …` / `toolbar.subtitle = …`
     * without re-walking the dialog's view tree. Cleared alongside
     * `currentWebView` on dismiss.
     */
    private var currentToolbar: Toolbar? = null

    /**
     * Bottom-bar message label of the current native webview, if any. Captured so
     * `patchWindowText` can push status text (e.g. "34 resources collected") next
     * to the navigation arrows without re-walking the view tree.
     */
    private var currentMessageView: TextView? = null

    /**
     * URL-fallback state machine for the current native webview. The page URL is shown
     * in the highest slot the caller has not yet claimed: the toolbar title
     * until a caller `title` arrives, then the subtitle until a caller
     * `subtitle` arrives, then neither slot. [currentUrl] tracks the live page
     * URL (updated on navigation via [onNavigate]); [titleClaimed] /
     * [subtitleClaimed] flip true the first time the caller supplies that field
     * (any value, including `""`). All three reset per open — a fresh [present]
     * or an in-place re-wire.
     */
    private var currentUrl: String = ""
    private var titleClaimed = false
    private var subtitleClaimed = false

    /**
     * The currently-presented native webview's JS-bridge. Captured so a second `open()`
     * against an existing native webview can rebind `bridge.channel = …` without
     * rebuilding the WebView (Task #7 re-wire). Cleared on dismiss.
     */
    private var currentBridge: Bridge? = null

    /**
     * Handle for the WebView's installed document-start script, when the
     * provider supports `DOCUMENT_START_SCRIPT`. Retained so a second `open()`
     * against this native webview can [ScriptHandler.remove] the prior script before
     * adding the new one — otherwise each re-wire stacks another copy and every
     * later page load runs the caller's init IIFE N+1 times (Task #7 re-wire).
     * Cleared on dismiss.
     */
    private var currentDocStartScript: ScriptHandler? = null

    /**
     * Set in [disposeDialog] before the dispose [Dialog.dismiss], cleared in the
     * dispose's `setOnDismissListener`. While true, [openUrl] queues its request
     * into [onDisposeFinishedHandler] rather than rewiring a doomed WebView —
     * `Dialog.dismiss()` only enqueues teardown via the UI thread, so a
     * same-tick re-`openUrl()` would otherwise see a non-null `currentWebView`
     * and incorrectly take the rewire branch (dispose→openUrl switch-demo race
     * guard).
     *
     * Crucially this is set ONLY by a dispose — a [hide] keeps the instance
     * alive, so during a hide animation `isDisposing` stays false and a same-tick
     * `openUrl` rewires in place instead of queuing a replay that would never run.
     */
    private var isDisposing = false

    /**
     * Replay closure set by [openUrl] when a dispose is in flight; consumed by
     * the dispose's dismiss path. When set, the dispose suppresses the `disposed`
     * channel echo and runs the replay — the caller logically continues with new
     * wiring rather than firing a spurious teardown. Last-write-wins on rapid
     * repeats.
     */
    private var onDisposeFinishedHandler: (() -> Unit)? = null

    /**
     * The [Invoke] whose `resolve` is owned by [onDisposeFinishedHandler]. Held
     * separately so a *second* `openUrl()` that supersedes a still-queued one
     * (both during the same dispose) can reject the superseded invoke before
     * its closure is overwritten — otherwise its JS promise hangs forever
     * (there's no timeout on `openUrl`).
     */
    private var pendingInvoke: Invoke? = null

    /**
     * UI-thread handler the hidden-idle teardown backstop posts on. The backstop
     * runnable ([idleTeardownRunnable]) auto-`dispose`s the instance after
     * [IDLE_TEARDOWN_MS] of inactivity while hidden; any activity (inbound bridge
     * message or any command) reposts it via [resetIdleTimer]. Posting on the
     * main looper keeps the teardown on the UI thread, where all the dialog /
     * WebView work happens.
     */
    private val idleHandler = Handler(Looper.getMainLooper())

    /**
     * The hidden-idle teardown action: auto-`dispose` the instance (emit
     * `disposed`) if it has sat hidden + idle past [IDLE_TEARDOWN_MS]. Guards on
     * still-hidden-and-present so a race with a `show` / `dispose` that landed
     * first is a no-op. Posted / removed via [resetIdleTimer] / [cancelIdleTimer].
     */
    private val idleTeardownRunnable = Runnable {
        if (dialog != null && !isVisible) {
            disposeDialog()
        }
    }

    /**
     * Ensure a native webview exists and navigate it to `url`. Builds the
     * WebView + its (not-yet-shown) `Dialog` if absent; on an existing instance
     * (visible OR hidden) re-wires (channel / initScript / chrome) and navigates
     * in place, PRESERVING current visibility. Never shows the dialog — call
     * [show] to present it. Resolves with `{opened: true}`. (Renamed from the
     * former `open`.)
     */
    @Command
    fun openUrl(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            // Any command is activity — push back the hidden-idle teardown backstop.
            resetIdleTimer()
            // Dispose in flight: queue replay for the dispose's dismiss path
            // (switch-demo race guard). `Dialog.dismiss()` enqueues teardown to
            // the UI thread; `isDisposing` covers the gap until the listener
            // fires. A HIDE never sets `isDisposing`, so a same-tick `openUrl`
            // during a hide animation skips this branch and rewires in place.
            if (isDisposing) {
                // Supersede any already-queued openUrl: settle its promise so two
                // quick `openUrl()`s during the dispose don't leave the first
                // one's `await` hung forever (last-write-wins would otherwise drop
                // its `resolve`).
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
            // Existing instance (visible OR hidden) and not being disposed:
            // rewire it in place, PRESERVING its current visibility (do NOT show
            // here). Channel rebinds via `bridge.channel = …`; the new
            // `initScript` is `eval`'d into the current page (NOT document-start
            // for the just-loaded one — caveat documented in `desktop.rs`) and
            // also added via `WebViewCompat.addDocumentStartJavaScript` so future
            // loads run it at document-start (when supported). Initial chrome
            // re-applies via the existing toolbar / message bindings.
            if (existing != null && bridge != null && d != null) {
                bridge.channel = args.nativeWebviewEventChannel
                args.initScript?.let { script ->
                    existing.evaluateJavascript(script, null)
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        // Remove the prior document-start script before adding
                        // the new one so repeated re-wires don't stack copies —
                        // otherwise every later page load runs the caller's init
                        // IIFE N+1 times (the sniffer would double-hook
                        // fetch/XHR). Task #7 re-wire.
                        currentDocStartScript?.remove()
                        currentDocStartScript =
                            WebViewCompat.addDocumentStartJavaScript(existing, script, setOf("*"))
                    }
                }

                // A re-wire is logically a fresh open: reset the URL-fallback
                // claim state (URL back in the title) and clear the message, then
                // re-apply the caller's initial chrome before navigating.
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
            // Any command is activity — push back the hidden-idle teardown backstop.
            resetIdleTimer()
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
            // Any command is activity — push back the hidden-idle teardown backstop.
            resetIdleTimer()
            val toolbar = currentToolbar
            val messageView = currentMessageView
            if (toolbar == null || messageView == null) {
                val result = JSObject()
                result.put("set", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            // Patch notation per field: `null` (key absent) = leave the label
            // unchanged; any present value (including `""`) claims that slot for
            // the caller, so the URL fallback stops painting it.
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
     * hidden-idle teardown backstop (a visible webview is never idle-reclaimed).
     */
    @Command
    fun show(invoke: Invoke) {
        activity.runOnUiThread {
            cancelIdleTimer()
            // A dispose teardown is in flight: `disposeDialog`'s `dialog.dismiss()`
            // only ENQUEUES the dismiss listener that destroys the WebView and
            // nulls `dialog`, so a same-tick `show` would still read a non-null
            // `dialog`, call `d.show()` on a doomed dialog, and flip `isVisible`
            // true on an instance about to be torn down (blank dialog /
            // use-after-destroy). Mirror `openUrl`'s `isDisposing` guard — there's
            // nothing presentable, so resolve `{requestCausedShow: false}`.
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
                // Already on screen — `dialog.show()` would be a no-op, and no
                // transition is caused, so report `false`.
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
     * running (do NOT tear it down). Routes through [hideDialog], which emits
     * `NativeWebviewEvent::Hidden` and arms the hidden-idle teardown backstop.
     * Resolves with `{requestCausedHide: false}` when nothing was visible,
     * `{requestCausedHide: true}` once hidden.
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
     * [disposeDialog] (which sets [isDisposing] so a same-tick `openUrl` queues a
     * replay rather than rewiring a doomed WebView); the dispose's
     * `setOnDismissListener` emits `NativeWebviewEvent::Disposed`. Resolves with
     * `{requestCausedDispose: false}` when none existed, `{requestCausedDispose:
     * true}` once torn down.
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
     * system back). Uses `dialog.hide()` (which does NOT fire
     * `setOnDismissListener`, so nothing is torn down), emits `Hidden` on the
     * latest channel, marks the instance hidden, and arms the idle backstop.
     */
    private fun hideDialog() {
        val d = dialog ?: return
        if (!isVisible) return
        // `dialog.hide()` detaches the window but keeps the Dialog + its WebView
        // alive and running — unlike `dismiss()`, it does NOT invoke the
        // dismiss listener, so no teardown happens.
        d.hide()
        isVisible = false
        // Emit `Hidden` on the latest (possibly re-wired) channel.
        currentBridge?.let { bridge ->
            val payload = JSObject()
            payload.put("event", "hidden")
            bridge.channel.send(payload)
        }
        // Now that it's hidden, start the idle backstop counting down.
        resetIdleTimer()
    }

    /**
     * Tear the native webview down with the race guard ([isDisposing]) set so a
     * same-tick `openUrl()` queues a replay via [onDisposeFinishedHandler]
     * rather than navigating the not-yet-torn-down WebView. Every teardown path
     * (host `dispose`, the hidden-idle backstop) goes through this. The actual
     * WebView teardown + `Disposed` emit happen in the `setOnDismissListener`
     * `dispose()` triggers — `dialog.dismiss()` fires that listener whether the
     * dialog was visible or hidden.
     */
    private fun disposeDialog() {
        val d = dialog ?: return
        cancelIdleTimer()
        isDisposing = true
        // `dismiss()` fires `setOnDismissListener` even for a hidden (but not
        // dismissed) dialog, so a dispose of a hidden instance still tears down
        // and emits `disposed`.
        d.dismiss()
    }

    /**
     * (Re)arm the hidden-idle teardown backstop to fire [IDLE_TEARDOWN_MS] from
     * now. Called on every activity — any inbound bridge message (via the
     * bridge's `onActivity`) and every command. The backstop only matters while
     * hidden; [idleTeardownRunnable] guards on still-hidden-and-present, and
     * [show] / [dispose] cancel it outright.
     */
    private fun resetIdleTimer() {
        idleHandler.removeCallbacks(idleTeardownRunnable)
        // Only count down while a hidden instance exists; when visible or absent
        // there is nothing to reclaim.
        if (dialog != null && !isVisible) {
            idleHandler.postDelayed(idleTeardownRunnable, IDLE_TEARDOWN_MS)
        }
    }

    /** Cancel the hidden-idle teardown backstop (instance shown or disposed). */
    private fun cancelIdleTimer() {
        idleHandler.removeCallbacks(idleTeardownRunnable)
    }

    /**
     * Apply the caller-supplied window text in one call — `null` = leave
     * unchanged; any present value (including `""`) *claims* that slot for the
     * caller and is shown verbatim (empty string clears the label). Operates on
     * the current native webview's [currentToolbar] / [currentMessageView], so it is
     * shared by `openUrl`'s initial chrome, the `patchWindowText` command, and the
     * re-wire path. After applying, [renderUrlFallback] paints the page URL into
     * the highest slot the caller still hasn't claimed.
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

    /**
     * Paint [currentUrl] into the highest slot the caller has not claimed: the
     * toolbar title until a caller `title` arrives, then the subtitle until a
     * caller `subtitle` arrives, then neither (both slots are caller-owned).
     * Caller-claimed slots are never overwritten here — they hold the values
     * set in [applyWindowText].
     */
    private fun renderUrlFallback() {
        if (!titleClaimed) {
            currentToolbar?.title = currentUrl.ifEmpty { null }
        } else if (!subtitleClaimed) {
            currentToolbar?.subtitle = currentUrl.ifEmpty { null }
        }
    }

    /**
     * Sync the URL fallback to a navigation. Called from the WebView client's
     * `onPageStarted`; rewrites whichever slot still shows the URL and no-ops
     * once both slots are claimed.
     */
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
        // Capture so `evaluateJs` can target it; cleared on dismiss below.
        currentWebView = webView

        // Reset the URL-fallback state machine for this fresh native webview: the page
        // URL starts in the title and falls through the slots as the caller
        // claims them (see [renderUrlFallback]).
        currentUrl = url
        titleClaimed = false
        subtitleClaimed = false

        // JS -> native bridge, reachable on any origin. Per-native-webview so a stacked
        // second `open` doesn't redirect the first native webview's events into the
        // second native webview's channel. Captured into [currentBridge] so a second
        // `open()` against this native webview can rebind `bridge.channel = …`
        // without rebuilding the WebView (Task #7).
        val bridge = Bridge(channel)
        webView.addJavascriptInterface(bridge, MESSAGE_HANDLER_NAME)
        currentBridge = bridge
        // Inbound bridge traffic is activity — reset the hidden-idle teardown.
        bridge.onActivity = { resetIdleTimer() }

        // Caller-supplied document-start script (e.g. browser-sniffer's bundled
        // installSniffer IIFE), injected on ANY origin when the WebView provider
        // supports DOCUMENT_START_SCRIPT; an onPageStarted fallback (below)
        // otherwise — note the fallback is not strictly before the page's scripts.
        val supportsDocumentStart =
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (initScript != null && supportsDocumentStart) {
            // Retain the handle so a later re-wire can remove this script
            // before adding its replacement (Task #7).
            currentDocStartScript =
                WebViewCompat.addDocumentStartJavaScript(webView, initScript, setOf("*"))
        } else if (initScript != null) {
            // The `onPageStarted` fallback fires AFTER the JS context exists,
            // so a page's inline `<script>` tag in `<head>` that synchronously
            // calls `fetch`/`XMLHttpRequest` will run before our injection —
            // those requests escape interception silently. WebView 83+ (API
            // level varies) provides DOCUMENT_START_SCRIPT; flag the
            // under-collection so an out-of-date device shows up in logs
            // rather than just producing thin data.
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
            // The Toolbar Close button is a USER dismissal — HIDE (keep the
            // instance alive + running) and emit `hidden`, NOT a teardown. Only
            // an explicit `dispose` tears down.
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

        // Apply caller-supplied initial chrome before the dialog shows so the
        // bar is correct on first paint (null = leave unchanged). The URL
        // fallback paints the page URL into the highest slot the caller hasn't
        // claimed, so an `open` with no title/subtitle still shows where the
        // native webview navigated.
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
                // Keep the URL fallback in sync with navigation: rewrite
                // whichever slot still shows the URL (title until claimed, then
                // subtitle). No-ops once the caller has claimed both. Done at
                // start (commit time) so the bar updates as soon as the
                // navigation begins, matching the desktop backend.
                pageUrl?.let { onNavigate(it) }
            }

            override fun onPageFinished(view: WebView, pageUrl: String?) {
                // Refresh the nav-arrow enabled state. `canGoBack` /
                // `canGoForward` are polled methods (no observable equivalent on
                // `android.webkit.WebView`); `onPageFinished` is the standard
                // hook every navigation hits. (The URL fallback is driven from
                // `onPageStarted` above.)
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
            // dismisses the native webview outright — surprising when the sniffer has
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
                        // System back at the root of history is a USER dismissal
                        // — consume it and HIDE (keep alive + emit `hidden`)
                        // through [hideDialog], NOT the default dialog dismiss
                        // (which would tear the WebView down). Only an explicit
                        // `dispose` tears down.
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
            // `dismiss()` fires ONLY from a [disposeDialog] (a host `dispose` or
            // the hidden-idle backstop) — a [hideDialog] uses `dialog.hide()`,
            // which does NOT invoke this listener. So this is unconditionally the
            // teardown path: free the WebView and emit `disposed`.
            setOnDismissListener {
                // Read the latest (possibly rewired) channel BEFORE dropping the
                // bridge: a re-wire rebinds `bridge.channel`, and the `disposed`
                // echo must follow it to the most recent caller — otherwise a
                // caller that re-opened with a fresh channel never sees the
                // teardown on its new channel (matches desktop's `CurrentChannel`
                // handling).
                val disposeChannel = currentBridge?.channel ?: channel
                // Tear down THIS native webview's WebView so a dispose doesn't
                // leak a fully-loaded WebView plus its `@JavascriptInterface`
                // (which pins the Bridge → plugin → Activity) and its still-live
                // JS/render thread. `webView` is the local captured at present()
                // time, so we destroy exactly this dialog's instance. iOS tears
                // down in its controller; Android matches here.
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
                // If `openUrl()` queued a replay during the dispose, run it now
                // and skip the `disposed` echo — the caller logically continues
                // with new wiring (switch-demo race guard). Otherwise this is a
                // real teardown; emit `disposed` so the host's collector releases
                // per-native-webview state.
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
            // Build HIDDEN: do NOT call `show()` here — navigation (`openUrl`)
            // and presentation (`show`) are separate concerns. The dialog is
            // captured into `dialog` above; `show` presents it later.
        }
        // The instance starts hidden; arm the idle-teardown backstop so a built-
        // but-never-shown instance is eventually reclaimed. `show` cancels it.
        isVisible = false
        resetIdleTimer()
    }

    /**
     * Natural-teardown backstop: when the host Activity is destroyed with a
     * native webview still alive (visible or hidden), dispose it so the WebView
     * + its `@JavascriptInterface` don't leak and the host's collector still
     * sees a terminal `disposed`. Mirrors the iOS controller-`deinit` backstop.
     * No-op when nothing exists. `dialog.dismiss()` (via [disposeDialog]) fires
     * the dispose teardown synchronously on this same UI thread.
     */
    override fun onDestroy(activity: AppCompatActivity) {
        if (dialog != null) {
            disposeDialog()
        }
        super.onDestroy(activity)
    }

    /**
     * JS -> native bridge surface exposed as `window.nativeWebview`. Each native webview
     * gets its own `Bridge` so events route to the matching caller's channel.
     *
     * `channel` is `var` so [openUrl]'s rewire branch can swap it without
     * rebuilding the WebView. `postMessage` snapshots the channel at post time so
     * an in-flight rebind doesn't reroute a message that was already queued under
     * the previous binding.
     *
     * `onActivity` is invoked for every inbound message so the plugin resets its
     * hidden-idle teardown backstop — any inbound bridge traffic counts as
     * activity (see [resetIdleTimer]).
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
            // Snapshot at post time: a rewire that lands between this hop and
            // the send shouldn't reroute an in-flight message.
            val initializedChannel = channel
            // `Channel.send` routes the payload over JNI to the Rust-registered
            // channel handler — it does NOT touch the host WebView, so it's
            // thread-safe to call directly on this binder thread. Keeping it off
            // the UI looper matters on the streaming hot path: a fast EHR stream
            // posts hundreds of `ResponseData` chunks/sec, and queuing each
            // behind pending UI/layout work would serialize all bridge traffic
            // through the main looper (iOS doesn't hop — its handler is already
            // main-thread). Posts arrive in call order, so FIFO is preserved.
            initializedChannel.send(payload)
            // Only the idle-timer reset needs the UI thread: it reads `dialog` /
            // `isVisible` (UI-thread-owned) and posts on the main-looper Handler.
            // Inbound traffic is activity — push back the hidden-idle teardown.
            activity.runOnUiThread {
                onActivity?.invoke()
            }
        }
    }
}
