package io.wildflowerhealth.nativepagebrowser

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
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
 * One view shows at a time, and a Custom Tab can't be closed programmatically,
 * so `open` rejects while a view is showing. It also rejects while the host
 * activity isn't in front: Android blocks activity starts from the background.
 * Every other `open` launches its view and resolves.
 *
 * A view counts as closed when the host activity resumes after pausing under
 * it, and that resume sends `{"event":"closed"}` on its channel: exactly once
 * per resolved `open`. Switching apps from the view (to a password manager or
 * an authenticator, mid-sign-in) leaves the view on top of the host's task, so
 * the host doesn't resume and the view stays open.
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

    /** One launched view, with the channel its close reports on. */
    private class Page(private val closed: Channel) {
        /** The host activity paused after this view launched: the view is up over it. */
        var hostLeft = false

        fun reportClosed() {
            // Lowercase tag matches `models.rs` `BrowserEvent`.
            val payload = JSObject()
            payload.put("event", "closed")
            closed.send(payload)
        }
    }

    /** The launched view, or null. UI thread only, like every field below. */
    private var showing: Page? = null

    /** The host activity is resumed. Tracked from [onPause] / [onResume]. */
    private var hostInFront = true

    /**
     * Present `url`. Resolves once the launch is issued; rejects while a view is
     * showing, while the host is in the background, or when nothing can open it.
     */
    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            if (showing != null) {
                invoke.reject(
                    "native-page-browser: could not open ${args.url}: a page is already open"
                )
                return@runOnUiThread
            }
            if (!hostInFront) {
                invoke.reject(
                    "native-page-browser: could not open ${args.url}: the app is in the background"
                )
                return@runOnUiThread
            }
            // Showing before the launch, so the pause the launch causes marks `hostLeft`.
            showing = Page(args.closed)
            try {
                startView(Uri.parse(args.url))
                invoke.resolve()
            } catch (error: Exception) {
                showing = null
                invoke.reject("native-page-browser: could not open ${args.url}: ${error.message}")
            }
        }
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
            CustomTabsIntent.Builder()
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

    override fun onPause() {
        super.onPause()
        hostInFront = false
        showing?.hostLeft = true
    }

    /** The host is back in front, so the view that was up over it is gone. */
    override fun onResume() {
        super.onResume()
        hostInFront = true
        val page = showing ?: return
        if (!page.hostLeft) return
        showing = null
        page.reportClosed()
    }
}
