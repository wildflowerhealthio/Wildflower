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
 * Arguments decoded from `invoke('plugin:native-webview|open_url', { id, url, initScript, nativeWebviewEventChannel })`.
 * Keys match the mobile `WithId<OpenRequest>` wire shape (`id` plus `OpenRequest`'s flattened fields).
 * `nativeWebviewEventChannel` is a Tauri `Channel<NativeWebviewEvent>` the caller receives
 * native webview events on (`{"event":"message", "payload": …}` / `{"event":"hidden"}` /
 * `{"event":"disposed"}`) — matches the `models.rs` `NativeWebviewEvent` serde shape.
 */
@InvokeArg
class OpenArgs {
    /**
     * Caller-named instance id (e.g. `"sniffer"`, `"launch"`) — routes to the
     * matching per-id instance in `NativeWebviewPlugin.instances`. Matches the
     * `WithId` wrapper the Rust `mobile.rs` serialises around `OpenRequest`.
     */
    lateinit var id: String
    lateinit var url: String
    var initScript: String? = null
    lateinit var nativeWebviewEventChannel: Channel

    // Chrome applied at presentation time (absent = null = leave unchanged).
    // Matches `OpenRequest`'s `initialTitle` / `initialSubtitle` /
    // `initialMessage` camelCase wire shape.
    var initialTitle: String? = null
    var initialSubtitle: String? = null
    var initialMessage: String? = null

    // Cookies to seed into the WebView's cookie store BEFORE the first
    // navigation to `url` (the apps-launch owner-session seeding). Matches
    // `OpenRequest`'s `cookies` wire shape; omitted (→ null) when empty.
    var cookies: List<CookieArg>? = null
}

/**
 * One cookie decoded from `OpenRequest`'s `cookies` entries — camelCase keys
 * matching `CookieSpec`'s serde wire shape (see `models.rs`).
 */
@InvokeArg
class CookieArg {
    lateinit var name: String
    lateinit var value: String

    /** `Domain` attribute: the cookie applies to this host and its subdomains. */
    lateinit var domain: String
    lateinit var path: String
    var secure: Boolean = false
    var httpOnly: Boolean = false

    /** `"strict"` / `"lax"` / `"none"` — pinned lowercase in `models.rs`. */
    lateinit var sameSite: String

    /** Lifetime in seconds from now; null = session cookie. */
    var maxAge: Long? = null
}

/**
 * Arguments decoded from `invoke('plugin:native-webview|evaluate_js', { id, script })`.
 * Keys match the mobile `WithId<EvaluateJsRequest>` camelCase serde wire shape. The host evaluates
 * `script` verbatim in the native webview — typically a
 * `window.__nativeWebviewReceive(JSON.stringify(...))` call carrying a bridge
 * envelope.
 */
@InvokeArg
class EvaluateJsArgs {
    /** Caller-named instance id — see `OpenArgs.id`. */
    lateinit var id: String
    lateinit var script: String
}

/**
 * Arguments decoded from `invoke('plugin:native-webview|patch_window_text', { id, title?, subtitle?, message? })`.
 * Each field is optional: `null` / absent = leave unchanged; empty string
 * clears that label. Matches `PatchWindowTextRequest`'s camelCase serde wire shape.
 */
@InvokeArg
class PatchWindowTextArgs {
    /** Caller-named instance id — see `OpenArgs.id`. */
    lateinit var id: String
    var title: String? = null
    var subtitle: String? = null
    var message: String? = null
}

/**
 * Arguments decoded from the id-only commands `show` / `hide` / `dispose`
 * (`invoke('plugin:native-webview|show', { id })`). Matches the Rust `IdOnly`
 * wrapper the mobile transport serialises for these argument-less commands.
 */
@InvokeArg
class IdArgs {
    lateinit var id: String
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

    /**
     * Live instances keyed by caller-named id. An entry is created by [present]
     * and removed by the terminal branch of the dispose `setOnDismissListener`.
     * Ids are a small fixed set (`sniffer`, `launch`), so the map never grows
     * unbounded. Mirrors the desktop backend's per-id `PluginState`.
     */
    private val instances = mutableMapOf<String, Instance>()

    /**
     * The id of the instance currently on screen, or `null` when none is. A phone
     * shows one native webview at a time; [show] swaps this (hiding the outgoing
     * instance, showing the incoming one — see § "Foreground swap"). Kept in sync
     * with the winning instance's [Instance.isVisible].
     */
    private var visibleId: String? = null

    /** Main-looper handler the per-instance idle teardown backstops post on (keeps teardown on the UI thread). */
    private val idleHandler = Handler(Looper.getMainLooper())

    /**
     * One native-webview instance's live state, keyed by caller-named [id] in
     * [instances]. Mirrors the desktop backend's per-id `InstanceState`: each
     * instance owns its own `Dialog`, `WebView`, chrome views, URL-fallback claim
     * state, JS bridge, document-start script handle, visibility + dispose flags,
     * deferred switch-demo replay, and idle-teardown runnable — so a background
     * `sniffer` scrape and a `launch` popup never trample each other's wiring. All
     * the cross-platform lifecycle/race protocols apply per instance.
     */
    private inner class Instance(val id: String) {
        /** This instance's `Dialog`. Held across a hide so the same live instance can be re-presented. */
        var dialog: Dialog? = null

        /**
         * Whether this instance is presently on screen — tracked explicitly
         * because a hidden instance is kept alive (see § "Visibility, liveness,
         * and existence are independent"). At most one instance is [isVisible] at
         * a time (the foreground-swap invariant, also tracked by [visibleId]).
         */
        var isVisible = false

        /** This instance's `WebView`. Held across a hide and cleared only on dispose, so `evaluateJs` rejects after teardown. */
        var webView: WebView? = null

        /** Top toolbar. Captured so `patchWindowText` sets its title/subtitle without re-walking the view tree. */
        var toolbar: Toolbar? = null

        /** Bottom-bar message label. Captured so `patchWindowText` pushes status text without re-walking the view tree. */
        var messageView: TextView? = null

        /**
         * Chrome URL-fallback state — see § "Chrome URL-fallback". [currentUrl]
         * tracks the live page URL (updated via [onNavigate]); [titleClaimed] /
         * [subtitleClaimed] flip true once the caller supplies that field. All
         * three reset per open ([present] or an in-place re-wire).
         */
        var currentUrl: String = ""
        var titleClaimed = false
        var subtitleClaimed = false

        /** This instance's JS-bridge. Captured so a re-open can rebind `bridge.channel` without rebuilding the WebView. */
        var bridge: Bridge? = null

        /**
         * Handle for the WebView's installed document-start script, when the
         * provider supports `DOCUMENT_START_SCRIPT`. Retained so a re-open can
         * [ScriptHandler.remove] the prior script before adding the new one — see
         * § "Re-open rewire".
         */
        var docStartScript: ScriptHandler? = null

        /**
         * Switch-demo race guard — see § "The dispose→open \"switch-demo\" race".
         * Set in [disposeDialog] before the dispose [Dialog.dismiss], cleared in
         * the dispose's `setOnDismissListener`. Set ONLY by a dispose, never by a
         * [hideDialog].
         */
        var isDisposing = false

        /** Deferred replay closure for the switch-demo race. Last-write-wins. */
        var onDisposeFinishedHandler: (() -> Unit)? = null

        /** The [Invoke] owned by [onDisposeFinishedHandler], held separately so a superseding `openUrl()` can reject it. */
        var pendingInvoke: Invoke? = null

        /** Exists but off screen — the only state the idle backstop reclaims. */
        val isHidden: Boolean
            get() = dialog != null && !isVisible

        /**
         * Teardown backstop action — see § "Teardown backstops". Auto-`dispose`s
         * THIS instance after [IDLE_TEARDOWN_MS] hidden + idle; guards on
         * [isHidden] so a `show`/`dispose` that landed first is a no-op. Per
         * instance because `Handler.removeCallbacks` keys on the Runnable identity.
         */
        val idleTeardownRunnable = Runnable {
            if (this@Instance.isHidden) {
                disposeDialog(this@Instance)
            }
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
        val id = args.id
        activity.runOnUiThread {
            resetIdleTimer(id) // a command counts as activity (no-op if no instance yet)
            val instance = instances[id]
            // Dispose in flight for THIS id — queue a deferred replay rather than
            // rewiring a doomed WebView. See docs/Lifecycle and Races Explanation.md
            // § "The dispose→open \"switch-demo\" race".
            if (instance != null && instance.isDisposing) {
                // Supersede any already-queued openUrl: reject its invoke so its
                // promise doesn't hang (last-write-wins would drop its `resolve`).
                instance.pendingInvoke?.reject(
                    "native-webview: superseded by a newer open() before the popup finished closing"
                )
                instance.pendingInvoke = invoke
                instance.onDisposeFinishedHandler = {
                    present(
                        id,
                        args.url,
                        args.initScript,
                        args.nativeWebviewEventChannel,
                        args.initialTitle,
                        args.initialSubtitle,
                        args.initialMessage,
                        args.cookies,
                    )
                    val result = JSObject()
                    result.put("opened", true)
                    invoke.resolve(result)
                }
                return@runOnUiThread
            }
            val existing = instance?.webView
            val bridge = instance?.bridge
            val d = instance?.dialog
            // Existing instance, not being disposed: rewire it in place — see
            // docs/Lifecycle and Races Explanation.md § "Re-open rewire". (Visibility is
            // preserved; we do NOT show here.)
            if (instance != null && existing != null && bridge != null && d != null) {
                bridge.channel = args.nativeWebviewEventChannel
                args.initScript?.let { script ->
                    existing.evaluateJavascript(script, null)
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        // Remove the prior document-start script before adding the
                        // new one so repeated re-wires don't stack copies.
                        instance.docStartScript?.remove()
                        instance.docStartScript =
                            WebViewCompat.addDocumentStartJavaScript(existing, script, setOf("*"))
                    }
                }

                // A re-wire is logically a fresh open: reset the URL-fallback
                // claim state and clear the message, then re-apply initial chrome.
                instance.currentUrl = args.url
                instance.titleClaimed = false
                instance.subtitleClaimed = false
                instance.messageView?.text = null
                applyWindowText(
                    instance,
                    args.initialTitle,
                    args.initialSubtitle,
                    args.initialMessage,
                )
                // Seed cookies before navigating so they ride the new target's
                // first request; the resolve stays immediate (`opened` means
                // "navigation dispatched", and the load is asynchronous anyway).
                seedCookies(args.cookies) {
                    existing.loadUrl(args.url)
                }
            } else {
                present(
                    id,
                    args.url,
                    args.initScript,
                    args.nativeWebviewEventChannel,
                    args.initialTitle,
                    args.initialSubtitle,
                    args.initialMessage,
                    args.cookies,
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
        val id = args.id
        activity.runOnUiThread {
            resetIdleTimer(id) // a command counts as activity
            val webView = instances[id]?.webView
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
        val id = args.id
        activity.runOnUiThread {
            resetIdleTimer(id) // a command counts as activity
            val instance = instances[id]
            if (instance == null || instance.toolbar == null || instance.messageView == null) {
                val result = JSObject()
                result.put("set", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            // Chrome URL-fallback — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback" (null = unchanged; any value, incl. "", claims the slot).
            applyWindowText(instance, args.title, args.subtitle, args.message)
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
        val args = invoke.parseArgs(IdArgs::class.java)
        val id = args.id
        activity.runOnUiThread {
            val instance = instances[id]
            if (instance == null) {
                val result = JSObject()
                result.put("requestCausedShow", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            cancelIdleTimer(instance)
            // Dispose teardown in flight — nothing presentable; showing the doomed
            // dialog would be a use-after-destroy. See docs/Lifecycle and Races Explanation.md
            // § "The dispose→open \"switch-demo\" race".
            if (instance.isDisposing) {
                val result = JSObject()
                result.put("requestCausedShow", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            val d = instance.dialog
            if (d == null) {
                val result = JSObject()
                result.put("requestCausedShow", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            if (instance.isVisible) {
                // Already on screen — no transition caused, so report `false`.
                val result = JSObject()
                result.put("requestCausedShow", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            // Foreground swap — a phone shows one native webview at a time, so hide
            // whichever instance is currently visible (keeping it ALIVE and
            // running) before showing `id`. `Dialog.hide()`/`show()` are
            // synchronous (no animation to sequence), so this is a simple swap.
            // See docs/Lifecycle and Races Explanation.md § "Foreground swap".
            visibleId?.let { currentId ->
                if (currentId != id) {
                    instances[currentId]?.let { current ->
                        if (current.isVisible) hideDialog(current)
                    }
                }
            }
            d.show()
            instance.isVisible = true
            visibleId = id
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
        val args = invoke.parseArgs(IdArgs::class.java)
        val id = args.id
        activity.runOnUiThread {
            val instance = instances[id]
            if (instance == null || instance.dialog == null || !instance.isVisible) {
                val result = JSObject()
                result.put("requestCausedHide", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            hideDialog(instance)
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
        val args = invoke.parseArgs(IdArgs::class.java)
        val id = args.id
        activity.runOnUiThread {
            val instance = instances[id]
            if (instance == null || instance.dialog == null) {
                val result = JSObject()
                result.put("requestCausedDispose", false)
                invoke.resolve(result)
                return@runOnUiThread
            }
            cancelIdleTimer(instance)
            disposeDialog(instance)
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
    private fun hideDialog(instance: Instance) {
        val d = instance.dialog ?: return
        if (!instance.isVisible) return
        d.hide()
        instance.isVisible = false
        if (visibleId == instance.id) visibleId = null
        // Emit `Hidden` on the latest (possibly re-wired) channel.
        instance.bridge?.let { bridge ->
            val payload = JSObject()
            payload.put("event", "hidden")
            bridge.channel.send(payload)
        }
        resetIdleTimer(instance.id) // hidden now — start the idle backstop counting down
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
    private fun disposeDialog(instance: Instance) {
        val d = instance.dialog ?: return
        cancelIdleTimer(instance)
        instance.isDisposing = true
        d.dismiss()
    }

    /**
     * (Re)arm instance `id`'s idle teardown backstop to fire [IDLE_TEARDOWN_MS]
     * from now, but only while that instance is hidden. Called on every activity
     * (inbound bridge message or any command). No-op if `id` has no instance. See
     * docs/Lifecycle and Races Explanation.md § "Teardown backstops".
     */
    private fun resetIdleTimer(id: String) {
        val instance = instances[id] ?: return
        idleHandler.removeCallbacks(instance.idleTeardownRunnable)
        if (instance.isHidden) {
            idleHandler.postDelayed(instance.idleTeardownRunnable, IDLE_TEARDOWN_MS)
        }
    }

    /** Cancel `instance`'s idle teardown backstop (instance shown or disposed). */
    private fun cancelIdleTimer(instance: Instance) {
        idleHandler.removeCallbacks(instance.idleTeardownRunnable)
    }

    /**
     * Apply caller-supplied window text and re-paint `instance`'s URL fallback —
     * see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback". `null` = leave
     * unchanged; any present value (incl. `""`) claims that slot. Shared by
     * `openUrl`'s initial chrome, `patchWindowText`, and the re-wire path.
     */
    private fun applyWindowText(
        instance: Instance,
        title: String?,
        subtitle: String?,
        message: String?,
    ) {
        title?.let {
            instance.titleClaimed = true
            instance.toolbar?.title = it.ifEmpty { null }
        }
        subtitle?.let {
            instance.subtitleClaimed = true
            instance.toolbar?.subtitle = it.ifEmpty { null }
        }
        message?.let { instance.messageView?.text = it.ifEmpty { null } }
        renderUrlFallback(instance)
    }

    /** Paint `instance`'s [Instance.currentUrl] into its highest unclaimed slot — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback". Claimed slots are never overwritten here. */
    private fun renderUrlFallback(instance: Instance) {
        if (!instance.titleClaimed) {
            instance.toolbar?.title = instance.currentUrl.ifEmpty { null }
        } else if (!instance.subtitleClaimed) {
            instance.toolbar?.subtitle = instance.currentUrl.ifEmpty { null }
        }
    }

    /** Sync `instance`'s URL fallback to a navigation (called from `onPageStarted`) — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback". */
    private fun onNavigate(instance: Instance, newUrl: String) {
        instance.currentUrl = newUrl
        renderUrlFallback(instance)
    }

    /**
     * Seed [cookies] into the process-global [android.webkit.CookieManager], then
     * run [thenLoad] once every `setCookie` completion fires — so the seed rides
     * the first request (mirrors desktop's `set_cookie` → `navigate` ordering; no
     * cookies → load immediately).
     *
     * Each cookie is written as a `Set-Cookie` header against `https://<domain>/`
     * (`CookieManager` validates a `Secure` cookie only against a secure URL); its
     * `Domain` attribute makes it subdomain-inclusive. NOTE: `CookieManager` is
     * process-global — the seeded cookie is visible to any WebView in this app on
     * the same host, not just this popup.
     */
    private fun seedCookies(cookies: List<CookieArg>?, thenLoad: () -> Unit) {
        if (cookies.isNullOrEmpty()) {
            thenLoad()
            return
        }
        val manager = android.webkit.CookieManager.getInstance()
        manager.setAcceptCookie(true)
        val remaining = java.util.concurrent.atomic.AtomicInteger(cookies.size)
        for (cookie in cookies) {
            val header = buildString {
                append(cookie.name).append('=').append(cookie.value)
                append("; Domain=").append(cookie.domain)
                append("; Path=").append(cookie.path)
                if (cookie.secure) append("; Secure")
                if (cookie.httpOnly) append("; HttpOnly")
                when (cookie.sameSite) {
                    "strict" -> append("; SameSite=Strict")
                    "lax" -> append("; SameSite=Lax")
                    "none" -> append("; SameSite=None")
                }
                cookie.maxAge?.let { append("; Max-Age=").append(it) }
            }
            val target = (if (cookie.secure) "https://" else "http://") + cookie.domain + "/"
            manager.setCookie(target, header) {
                if (remaining.decrementAndGet() == 0) {
                    // Persist to disk (best-effort; in-memory visibility is
                    // already guaranteed by the completed callbacks), then load
                    // back on the main thread — the callback thread is
                    // unspecified and loadUrl is main-thread-only.
                    manager.flush()
                    Handler(Looper.getMainLooper()).post(thenLoad)
                }
            }
        }
    }

    private fun present(
        id: String,
        url: String,
        initScript: String?,
        channel: Channel,
        initialTitle: String?,
        initialSubtitle: String?,
        initialMessage: String?,
        cookies: List<CookieArg>?,
    ) {
        // Fresh per-id instance; overwrites any prior (torn-down) entry for this id.
        val instance = Instance(id)
        instances[id] = instance

        val webView = WebView(activity)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        instance.webView = webView

        // Reset the URL-fallback state for this fresh native webview.
        instance.currentUrl = url
        instance.titleClaimed = false
        instance.subtitleClaimed = false

        val bridge = Bridge(channel)
        webView.addJavascriptInterface(bridge, MESSAGE_HANDLER_NAME)
        instance.bridge = bridge
        bridge.onActivity = { resetIdleTimer(id) } // inbound traffic is activity

        // Caller-supplied document-start script (e.g. browser-sniffer's bundled
        // installSniffer IIFE), injected on ANY origin when the WebView provider
        // supports DOCUMENT_START_SCRIPT; an onPageStarted fallback (below)
        // otherwise — note the fallback is not strictly before the page's scripts.
        val supportsDocumentStart =
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (initScript != null && supportsDocumentStart) {
            // Retain the handle so a later re-wire can remove this script
            // before adding its replacement.
            instance.docStartScript =
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
            setNavigationOnClickListener { hideDialog(instance) }
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
        instance.toolbar = toolbar

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
        instance.messageView = messageView

        // Apply caller-supplied initial chrome before the dialog shows so the bar
        // is correct on first paint — see docs/Lifecycle and Races Explanation.md § "Chrome URL-fallback".
        applyWindowText(instance, initialTitle, initialSubtitle, initialMessage)

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
                pageUrl?.let { onNavigate(instance, it) }
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

        // Seed cookies first, then load — the seed must ride the first request
        // (see [seedCookies]). With no cookies this loads immediately.
        seedCookies(cookies) {
            webView.loadUrl(url)
        }

        instance.dialog = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen).apply {
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
                        hideDialog(instance)
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
                val disposeChannel = instance.bridge?.channel ?: channel
                // Tear down THIS dialog's WebView (the `webView` local captured at
                // present() time) so a dispose doesn't leak a fully-loaded WebView,
                // its `@JavascriptInterface` (which pins Bridge → plugin →
                // Activity), and its still-live JS/render thread.
                webView.stopLoading()
                webView.removeJavascriptInterface(MESSAGE_HANDLER_NAME)
                (webView.parent as? ViewGroup)?.removeView(webView)
                webView.destroy()
                cancelIdleTimer(instance)
                instance.dialog = null
                instance.isVisible = false
                if (visibleId == id) visibleId = null
                instance.webView = null
                instance.toolbar = null
                instance.messageView = null
                instance.bridge = null
                instance.docStartScript = null
                instance.isDisposing = false
                // If `openUrl()` queued a replay during the dispose, run it and
                // skip the `disposed` echo; otherwise drop the instance entry and
                // emit `disposed`. See docs/Lifecycle and Races Explanation.md
                // § "The dispose→open \"switch-demo\" race".
                val pending = instance.onDisposeFinishedHandler
                instance.onDisposeFinishedHandler = null
                if (pending != null) {
                    instance.pendingInvoke = null
                    // The replay's `present(id, …)` overwrites `instances[id]` with a
                    // fresh instance, so leave the (now-cleared) entry for it to replace.
                    pending()
                } else {
                    // Terminal teardown for this id: drop the entry so a later
                    // `openUrl` builds fresh. NativeWebviewEvent.disposed (lowercase
                    // tag) — matches the `models.rs` shape.
                    instances.remove(id)
                    val payload = JSObject()
                    payload.put("event", "disposed")
                    disposeChannel.send(payload)
                }
            }
            // Build HIDDEN — do NOT call `show()` here (`show` presents it later).
        }
        // Arm the idle backstop so a built-but-never-shown instance is reclaimed.
        instance.isVisible = false
        resetIdleTimer(id)
    }

    /**
     * Activity-destroy teardown backstop — see docs/Lifecycle and Races Explanation.md
     * § "Teardown backstops". When the host Activity is destroyed with an
     * instance still alive, dispose it so it doesn't leak and the host still sees
     * a terminal `disposed`. Mirrors the iOS controller-`deinit` backstop;
     * `disposeDialog`'s `dialog.dismiss()` runs the teardown synchronously here.
     */
    override fun onDestroy(activity: AppCompatActivity) {
        // Snapshot the values first — `disposeDialog` → `dialog.dismiss()` runs the
        // dismiss listener synchronously here, which removes the entry from
        // [instances], so iterating the live map directly would mutate it under us.
        instances.values.toList().forEach { instance ->
            if (instance.dialog != null) {
                disposeDialog(instance)
            }
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
