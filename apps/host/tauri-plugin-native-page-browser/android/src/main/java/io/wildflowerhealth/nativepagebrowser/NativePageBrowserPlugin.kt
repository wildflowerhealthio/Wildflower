package io.wildflowerhealth.nativepagebrowser

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.toBitmap
import app.tauri.Logger
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Arguments decoded from `invoke('plugin:native-page-browser|open', { url, closed })`.
 * Keys match `OpenRequest`'s camelCase serde wire shape (see `models.rs`).
 * `closed` is a Tauri `Channel<BrowserEvent>` that hears `{"event":"closed"}`
 * once this view is gone.
 */
@InvokeArg
class OpenArgs {
    lateinit var url: String
    lateinit var closed: Channel
}


/**
 * Presents an external URL in a Custom Tab, the system's in-app browser: the
 * app can't script the page or read what's typed into it. It slides in from the
 * right in the app's colours with a back-arrow close button, and falls back to
 * the default browser (`ACTION_VIEW`) when no Custom Tabs provider is installed.
 *
 * One view shows at a time — `open` closes a showing view (reporting its close)
 * before launching the next. Every open sends `{"event":"closed"}` exactly once
 * on its channel: from the Custom Tabs session's `TAB_HIDDEN` when a session is
 * bound, and otherwise when the host activity next resumes.
 *
 * Views launch only while the host activity is in front. An `open` that arrives
 * with the host in the background — the usual case when it replaces a showing
 * view — waits for the host's next resume: Android blocks activity starts from
 * the background, and a view launched over a host that never resumes in between
 * would see no pause to mark it as up.
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
    }

    /**
     * One opened view, with the URL it shows and the channel its close reports
     * on. [reportClosed] sends at most once, so the `TAB_HIDDEN`, resume and
     * replacement paths can all reach it.
     */
    private class Page(val url: Uri, private val closed: Channel) {
        /** The host activity paused after this view launched: the view is up over it. */
        var hostLeft = false
        private var reported = false

        fun reportClosed() {
            if (reported) return
            reported = true
            // Lowercase tag matches `models.rs` `BrowserEvent`.
            val payload = JSObject()
            payload.put("event", "closed")
            closed.send(payload)
        }
    }

    /** The launched view, or null. UI thread only, like every field below. */
    private var showing: Page? = null

    /** An opened view waiting for the host's next resume to launch, or null. */
    private var pending: Page? = null

    /** The host activity is resumed. Tracked from [onPause] / [onResume]. */
    private var hostInFront = true

    /**
     * Bound Custom Tabs service; null until the provider connects, or when no
     * provider exists. A view launched without it reports its close on resume.
     */
    private var customTabsClient: CustomTabsClient? = null

    private val customTabsConnection =
        object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                customTabsClient = client
            }

            override fun onServiceDisconnected(name: ComponentName) {
                customTabsClient = null
            }
        }

    /** Whether [customTabsConnection] is bound, so [onDestroy] unbinds only what it bound. */
    private var customTabsBound = false

    override fun load(webView: WebView) {
        super.load(webView)
        // Bind early so the first `open` already has a session to hear
        // `TAB_HIDDEN` on.
        val provider = CustomTabsClient.getPackageName(activity, null) ?: return
        customTabsBound =
            CustomTabsClient.bindCustomTabsService(activity, provider, customTabsConnection)
    }

    /**
     * Present `url`, first closing any showing view. Resolves once the launch is
     * issued, or once it is queued for the host's next resume.
     */
    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            closeShowing()
            // A queued view that never launched is replaced too, and still
            // reports its one close.
            pending?.reportClosed()
            val page = Page(Uri.parse(args.url), args.closed)
            if (!hostInFront) {
                pending = page
                invoke.resolve()
                return@runOnUiThread
            }
            pending = null
            try {
                launch(page)
                invoke.resolve()
            } catch (error: Exception) {
                invoke.reject("native-page-browser: could not open ${args.url}: ${error.message}")
            }
        }
    }

    /**
     * Report the showing view closed and take it off screen. A Custom Tab can't
     * be closed programmatically, so this brings the host activity back to the
     * front: `CLEAR_TOP` finishes the tab above it in the task, and `SINGLE_TOP`
     * keeps the existing activity instead of recreating it.
     */
    private fun closeShowing() {
        val page = showing ?: return
        showing = null
        page.reportClosed()
        if (page.hostLeft) {
            activity.startActivity(
                Intent(activity, activity.javaClass)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            )
        }
    }

    /** Launch `page` over the host and make it the showing view. Throws when nothing can open it. */
    private fun launch(page: Page) {
        // Showing before the launch, so the pause the launch causes marks `hostLeft`.
        showing = page
        try {
            startView(page)
        } catch (error: Exception) {
            showing = null
            throw error
        }
    }

    private fun startView(page: Page) {
        val provider = CustomTabsClient.getPackageName(activity, null)
        if (provider == null) {
            // No Custom Tabs provider: the default browser, closed on resume.
            activity.startActivity(Intent(Intent.ACTION_VIEW, page.url))
            return
        }
        // A session per view, so a replaced view's late `TAB_HIDDEN` reaches its
        // own page rather than the one replacing it.
        val session =
            customTabsClient?.newSession(
                object : CustomTabsCallback() {
                    override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
                        if (navigationEvent != CustomTabsCallback.TAB_HIDDEN) return
                        activity.runOnUiThread { reportClosed(page) }
                    }
                }
            )
        // A null session builds an intent with no session (closed on resume).
        val builder = CustomTabsIntent.Builder(session)
        val night =
            (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES
        val customTabsIntent =
            builder
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
        // A session already ties the intent to its provider; without one, name
        // the provider so Android doesn't offer a chooser.
        if (session == null) customTabsIntent.intent.setPackage(provider)
        customTabsIntent.launchUrl(activity, page.url)
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

    /** Report `page` closed, and forget it if it is still the showing view. */
    private fun reportClosed(page: Page) {
        if (showing === page) showing = null
        page.reportClosed()
    }

    override fun onPause() {
        super.onPause()
        hostInFront = false
        showing?.hostLeft = true
    }

    /**
     * The host is back in front, so the view that was up over it is gone. This
     * is how a view without a session (or the default-browser fallback) reports
     * its close, and it backs up a session whose `TAB_HIDDEN` never arrives.
     * Then a queued view launches.
     */
    override fun onResume() {
        super.onResume()
        hostInFront = true
        showing?.let { page -> if (page.hostLeft) reportClosed(page) }
        val queued = pending ?: return
        pending = null
        try {
            launch(queued)
        } catch (error: Exception) {
            // Its `open` already resolved, so the failure can only be logged; the
            // close report still ends the caller's view.
            Logger.error("native-page-browser: could not open ${queued.url}", error)
            queued.reportClosed()
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (customTabsBound) {
            activity.unbindService(customTabsConnection)
            customTabsBound = false
        }
        super.onDestroy(activity)
    }
}
