package com.plugin.nativewebview

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.Toolbar
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** Arguments decoded from `invoke('plugin:native-webview|open', { url, initScript })`. */
@InvokeArg
class OpenArgs {
    lateinit var url: String
    var initScript: String? = null
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
    }

    private var dialog: Dialog? = null

    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            present(args.url, args.initScript)
            val result = JSObject()
            result.put("opened", true)
            invoke.resolve(result)
        }
    }

    private fun present(url: String, initScript: String?) {
        val webView = WebView(activity)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true

        // JS -> native bridge, reachable on any origin.
        webView.addJavascriptInterface(Bridge(), MESSAGE_HANDLER_NAME)

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
            setBackgroundColor(Color.parseColor("#14161C"))
            navigationIcon = activity.getDrawable(android.R.drawable.ic_menu_close_clear_cancel)
            setNavigationOnClickListener { dialog?.dismiss() }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, pageUrl: String?, favicon: Bitmap?) {
                if (initScript != null && !supportsDocumentStart) {
                    view.evaluateJavascript(initScript, null)
                }
            }

            override fun onPageFinished(view: WebView, pageUrl: String?) {
                toolbar.title = Uri.parse(view.url ?: pageUrl ?: url).host
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
        }

        webView.loadUrl(url)

        dialog = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen).apply {
            setContentView(layout)
            setOnDismissListener { trigger("closed", JSObject()) }
            show()
        }
    }

    /** JS -> native bridge surface exposed as `window.nativeWebview`. */
    inner class Bridge {
        @JavascriptInterface
        fun postMessage(json: String) {
            // The injected adapter posts an opaque JSON string (the sniffer's
            // wire message). Forward it verbatim; the host parses it.
            val payload = JSObject()
            payload.put("payload", json)
            // `@JavascriptInterface` callbacks run off the UI thread; hop back
            // before emitting to the host webview.
            activity.runOnUiThread { trigger("message", payload) }
        }
    }
}
