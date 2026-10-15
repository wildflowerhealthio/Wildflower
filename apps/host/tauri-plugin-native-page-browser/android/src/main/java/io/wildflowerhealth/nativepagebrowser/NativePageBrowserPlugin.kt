package io.wildflowerhealth.nativepagebrowser

import android.app.Activity
import android.app.Application
import android.content.ComponentName
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.toBitmap
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Arguments decoded from
 * `invoke('plugin:native-page-browser|open', { url, view, mode, events })`.
 * Keys match `OpenRequest`'s camelCase serde wire shape (see `models.rs`).
 * `view` is the caller's name for the view, which `close` takes; a Custom Tab
 * can't be closed, so nothing here reads it. `mode` is `models.rs` `OpenMode`:
 * `"replace"` or `"stack"`. `events` is a Tauri `Channel<BrowserEvent>`
 * that hears `{"event":"keptAlive"}` when the view's browser keeps the app
 * alive, and `{"event":"closed"}` once this view is gone.
 */
@InvokeArg
class OpenArgs {
    lateinit var url: String
    lateinit var view: String
    lateinit var mode: String
    lateinit var events: Channel
}

/**
 * Presents an external URL in a Custom Tab, the system's in-app browser: the
 * app can't script the page or read what's typed into it. It slides in from the
 * right in the app's colours with a back-arrow close button, and falls back to
 * the default browser (`ACTION_VIEW`) when no Custom Tabs provider is installed.
 *
 * A Custom Tab runs in its browser's process, so under one Android treats the
 * app as in the background and cuts its network. The plugin binds the
 * provider's Custom Tabs service for a session, and launches each tab from it
 * with the keep-alive extra naming [KeepAliveService]: a browser that honours
 * it (Chrome does) binds that service while the tab is open, which keeps the
 * app alive, and the binding sends `{"event":"keptAlive"}`. An `open` that
 * arrives before the session has connected waits up to
 * [SESSION_WAIT_MILLIS] for it, then launches without one.
 *
 * A Custom Tab can't be closed programmatically, so `close` rejects. An `open`
 * arriving while the host is in front can only find views still launching (a
 * second tap before the tab covers the host). A `replace` open joins the
 * latest of them, when a `replace` open launched it, instead of launching
 * another, and resolves as that view's `open` does; over a `stack` open's
 * view, it launches its own, so its URL opens. A `stack` open launches a view
 * of its own, which shows over them. `open` rejects while the host activity isn't in front: Android blocks
 * activity starts from the background. Every other `open` launches its view
 * and resolves.
 *
 * A view counts as closed when the host activity resumes after pausing under
 * it, and that resume sends `{"event":"closed"}` on the channel of each `open`
 * that launched or joined it: exactly once per resolved `open`. Views stacked
 * one over another are all in the host's task, so the host resumes only once
 * the last of them is closed, and every one reports its close then. Switching apps
 * from the view (to a password manager or an authenticator, mid-sign-in) leaves
 * the view on top of the host's task, so the host doesn't resume and the view
 * stays open.
 *
 * The plugin watches the host activity through the application's activity
 * lifecycle callbacks, not [Plugin.onPause] / [Plugin.onResume]: Tauri's
 * generated `TauriActivity` never registers the observer that forwards those.
 */
@TauriPlugin
class NativePageBrowserPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        // App palette as 0xAARRGGBB ints, one pair per token. Same tokens and
        // values as `tauri-plugin-native-webview`'s palette and the web app's
        // --color-background / --color-neutral-1.
        private const val COLOR_BACKGROUND_LIGHT = 0xFFF7ECDD.toInt()
        private const val COLOR_BACKGROUND_DARK = 0xFF221B16.toInt()
        private const val COLOR_NEUTRAL_1_LIGHT = 0xFF2C211D.toInt()
        private const val COLOR_NEUTRAL_1_DARK = 0xFFF3E9DB.toInt()

        /**
         * The Custom Tabs extra asking the browser to bind a service of the
         * app's while the tab is open. Not in `androidx.browser`'s API; Chrome
         * honours it only on a tab launched from a session.
         */
        private const val EXTRA_KEEP_ALIVE = "android.support.customtabs.extra.KEEP_ALIVE"

        /** How long an `open` waits for the Custom Tabs session to connect. */
        private const val SESSION_WAIT_MILLIS = 1_000L

        /** `models.rs` `OpenMode::Stack`, as [OpenArgs.mode] carries it. */
        private const val MODE_STACK = "stack"
    }

    /**
     * One view, from its `open` until its close, with the channel of each
     * `open` that launched or joined it, and the joined `open`s still waiting
     * for the launch. `stacked`: a `stack` open launched it.
     */
    private class Page(events: Channel, val stacked: Boolean) {
        private val eventChannels = mutableListOf(events)
        private val invokesAwaitingLaunch = mutableListOf<Invoke>()

        /** The view's launch is issued. */
        var launched = false
            private set

        /** The host activity paused after this view launched: the view is up over it. */
        var hostLeft = false

        private var keptAlive = false

        /**
         * A later `open` lands on this view: it hears the view's events on
         * `events`, and resolves once the view has launched.
         */
        fun join(invoke: Invoke, events: Channel) {
            eventChannels.add(events)
            if (keptAlive) send(events, "keptAlive")
            if (launched) invoke.resolve() else invokesAwaitingLaunch.add(invoke)
        }

        /** The launch is issued: every joined `open` resolves. */
        fun markLaunched() {
            launched = true
            invokesAwaitingLaunch.forEach { it.resolve() }
            invokesAwaitingLaunch.clear()
        }

        /** The launch failed with `message`: every joined `open` rejects with it. */
        fun rejectJoined(message: String) {
            invokesAwaitingLaunch.forEach { it.reject(message) }
            invokesAwaitingLaunch.clear()
        }

        fun reportKeptAlive() {
            if (keptAlive) return
            keptAlive = true
            eventChannels.forEach { send(it, "keptAlive") }
        }

        fun reportClosed() {
            eventChannels.forEach { send(it, "closed") }
        }

        private fun send(events: Channel, event: String) {
            // Tags match `models.rs` `BrowserEvent`.
            val payload = JSObject()
            payload.put("event", event)
            events.send(payload)
        }
    }

    /** The views from their `open` until their close, oldest first. UI thread only, like every field below. */
    private val showing = mutableListOf<Page>()

    /** The host activity is resumed. Tracked by [HostLifecycle]. */
    private var hostInFront = true

    /** The Custom Tabs session tabs launch from, once connected. */
    private var customTabsSession: CustomTabsSession? = null

    /** The provider's Custom Tabs service is binding, so a session may connect. */
    private var sessionConnecting = false

    /** What runs once the session connects or [SESSION_WAIT_MILLIS] pass. */
    private val awaitingSession = mutableListOf<() -> Unit>()

    private val mainHandler = Handler(Looper.getMainLooper())

    private val runAwaitingSession = Runnable {
        val actions = awaitingSession.toList()
        awaitingSession.clear()
        actions.forEach { it() }
    }

    init {
        activity.application.registerActivityLifecycleCallbacks(HostLifecycle())
        KeepAliveService.onBound = { showing.forEach { it.reportKeptAlive() } }
        connectSession()
    }

    /** Bind the Custom Tabs provider's service, for a session tabs launch from. */
    private fun connectSession() {
        val provider = CustomTabsClient.getPackageName(activity, null) ?: return
        sessionConnecting =
            CustomTabsClient.bindCustomTabsService(
                activity,
                provider,
                object : CustomTabsServiceConnection() {
                    override fun onCustomTabsServiceConnected(
                        name: ComponentName,
                        client: CustomTabsClient,
                    ) {
                        client.warmup(0)
                        customTabsSession = client.newSession(null)
                        sessionConnecting = false
                        mainHandler.removeCallbacks(runAwaitingSession)
                        runAwaitingSession.run()
                    }

                    /** The provider went away (updated, or killed): connect again. */
                    override fun onServiceDisconnected(name: ComponentName?) {
                        customTabsSession = null
                        activity.unbindService(this)
                        connectSession()
                    }
                },
            )
    }

    /** Run `action` once the session has connected, or at most [SESSION_WAIT_MILLIS] from now. */
    private fun whenSessionReady(action: () -> Unit) {
        if (customTabsSession != null || !sessionConnecting) {
            action()
            return
        }
        awaitingSession.add(action)
        mainHandler.removeCallbacks(runAwaitingSession)
        mainHandler.postDelayed(runAwaitingSession, SESSION_WAIT_MILLIS)
    }

    /**
     * Present `url`. Resolves once the launch is issued, also for an `open`
     * that joins a view still launching; rejects while the host is in the
     * background, or when nothing can open it.
     */
    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            if (!hostInFront) {
                invoke.reject(
                    "native-page-browser: could not open ${args.url}: the app is in the background"
                )
                return@runOnUiThread
            }
            // The host is in front, so a showing view hasn't covered it yet.
            val stacked = args.mode == MODE_STACK
            val launching = showing.lastOrNull()
            if (launching != null && !stacked && !launching.stacked) {
                launching.join(invoke, args.events)
                return@runOnUiThread
            }
            val page = Page(args.events, stacked)
            showing.add(page)
            whenSessionReady { launch(page, invoke, Uri.parse(args.url)) }
        }
    }

    /** A Custom Tab can't be closed programmatically: rejects, whichever view it names. */
    @Command
    fun close(invoke: Invoke) {
        invoke.reject("native-page-browser: a Custom Tab can't be closed by the app")
    }

    /** Launch `page`'s view of `url`, unless the host left while it waited for the session. */
    private fun launch(page: Page, invoke: Invoke, url: Uri) {
        val failure =
            if (!hostInFront) {
                "the app is in the background"
            } else {
                try {
                    // Launched before the start, so the pause the start causes marks `hostLeft`.
                    page.markLaunched()
                    startView(url)
                    null
                } catch (error: Exception) {
                    error.message ?: error.toString()
                }
            }
        if (failure == null) {
            invoke.resolve()
            return
        }
        showing.remove(page)
        val message = "native-page-browser: could not open $url: $failure"
        page.rejectJoined(message)
        invoke.reject(message)
    }

    /** Launch the view for `url` over the host. Throws when nothing can open it. */
    private fun startView(url: Uri) {
        val provider = CustomTabsClient.getPackageName(activity, null)
        if (provider == null) {
            // No Custom Tabs provider: the default browser.
            activity.startActivity(Intent(Intent.ACTION_VIEW, url))
            return
        }
        val night =
            (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES
        val customTabsIntent =
            (customTabsSession?.let { CustomTabsIntent.Builder(it) } ?: CustomTabsIntent.Builder())
                // Push-style: the tab slides in from the right over the app, and
                // slides back out to the right when closed.
                .setStartAnimations(activity, R.anim.npb_slide_in_right, R.anim.npb_slide_out_left)
                .setExitAnimations(activity, R.anim.npb_slide_in_left, R.anim.npb_slide_out_right)
                .setColorScheme(CustomTabsIntent.COLOR_SCHEME_SYSTEM)
                .setColorSchemeParams(
                    CustomTabsIntent.COLOR_SCHEME_LIGHT,
                    colorSchemeParams(COLOR_BACKGROUND_LIGHT),
                )
                .setColorSchemeParams(
                    CustomTabsIntent.COLOR_SCHEME_DARK,
                    colorSchemeParams(COLOR_BACKGROUND_DARK),
                )
                // A bitmap can't follow the system scheme, so the icon takes the
                // current appearance's colour.
                .setCloseButtonIcon(
                    backArrowIcon(if (night) COLOR_NEUTRAL_1_DARK else COLOR_NEUTRAL_1_LIGHT)
                )
                .setUrlBarHidingEnabled(true)
                .build()
        // Name the provider so Android doesn't offer a chooser.
        customTabsIntent.intent.setPackage(provider)
        customTabsIntent.intent.putExtra(
            EXTRA_KEEP_ALIVE,
            Intent().setClassName(activity.packageName, KeepAliveService::class.java.name),
        )
        customTabsIntent.launchUrl(activity, url)
    }

    private fun colorSchemeParams(colorBackground: Int): CustomTabColorSchemeParams =
        CustomTabColorSchemeParams.Builder()
            .setToolbarColor(colorBackground)
            .setNavigationBarColor(colorBackground)
            .build()

    /** The back-arrow close icon as the bitmap `setCloseButtonIcon` takes, tinted `color`. */
    private fun backArrowIcon(color: Int) =
        ContextCompat.getDrawable(activity, R.drawable.npb_ic_arrow_back)!!
            .mutate()
            .apply { setTint(color) }
            .toBitmap()

    private fun hostPaused() {
        hostInFront = false
        // A view still waiting for the session hasn't covered the host.
        showing.filter { it.launched }.forEach { it.hostLeft = true }
    }

    /** The host is back in front, so the views that were up over it are gone. */
    private fun hostResumed() {
        hostInFront = true
        val gone = showing.filter { it.hostLeft }
        showing.removeAll(gone)
        gone.forEach { it.reportClosed() }
    }

    /** Hears the host activity pause and resume; ignores every other activity. */
    private inner class HostLifecycle : Application.ActivityLifecycleCallbacks {
        override fun onActivityPaused(paused: Activity) {
            if (paused === activity) hostPaused()
        }

        override fun onActivityResumed(resumed: Activity) {
            if (resumed === activity) hostResumed()
        }

        override fun onActivityCreated(created: Activity, savedInstanceState: Bundle?) {}

        override fun onActivityStarted(started: Activity) {}

        override fun onActivityStopped(stopped: Activity) {}

        override fun onActivitySaveInstanceState(saved: Activity, outState: Bundle) {}

        override fun onActivityDestroyed(destroyed: Activity) {}
    }
}
