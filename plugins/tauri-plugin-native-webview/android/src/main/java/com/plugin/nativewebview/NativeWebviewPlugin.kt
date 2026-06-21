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
import org.json.JSONObject

/** Arguments decoded from `invoke('plugin:native-webview|open', { url })`. */
@InvokeArg
class OpenArgs {
    lateinit var url: String
}

/**
 * Android counterpart to the iOS `NativeWebviewPlugin`. Presents an
 * `android.webkit.WebView` in a fullscreen `Dialog` with a native `Toolbar`
 * (Close + page host), injecting JS at document start on any origin and
 * forwarding the page's pings to the host webview via the plugin event channel.
 */
@TauriPlugin
class NativeWebviewPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        /** `window.<name>` the injected bridge posts to (a `@JavascriptInterface`). */
        private const val MESSAGE_HANDLER_NAME = "nativeWebview"

        /**
         * Injected at document start into every page on ANY origin. Thin slice:
         * posts lifecycle pings only. Replaced by the real sniffer body later.
         */
        private val INJECTED_SOURCE =
            """
            (function () {
              try {
                var post = function (payload) {
                  if (window.$MESSAGE_HANDLER_NAME && window.$MESSAGE_HANDLER_NAME.postMessage) {
                    window.$MESSAGE_HANDLER_NAME.postMessage(JSON.stringify(payload));
                  }
                };
                post({ kind: 'injected', url: location.href });
                document.addEventListener('DOMContentLoaded', function () {
                  post({ kind: 'domcontentloaded', url: location.href });
                });
                window.addEventListener('load', function () {
                  post({ kind: 'load', url: location.href });
                });
              } catch (error) {}
            })();
            """.trimIndent()
    }

    private var dialog: Dialog? = null

    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            present(args.url)
            val result = JSObject()
            result.put("opened", true)
            invoke.resolve(result)
        }
    }

    private fun present(url: String) {
        val webView = WebView(activity)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true

        // JS -> native bridge, reachable on any origin.
        webView.addJavascriptInterface(Bridge(), MESSAGE_HANDLER_NAME)

        // Document-start injection on ANY origin when the WebView provider
        // supports it; an onPageStarted fallback (below) otherwise — note the
        // fallback is not strictly before the page's own scripts.
        val supportsDocumentStart =
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (supportsDocumentStart) {
            WebViewCompat.addDocumentStartJavaScript(webView, INJECTED_SOURCE, setOf("*"))
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
                if (!supportsDocumentStart) {
                    view.evaluateJavascript(INJECTED_SOURCE, null)
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
            try {
                val obj = JSONObject(json)
                val payload = JSObject()
                payload.put("kind", obj.optString("kind"))
                payload.put("url", obj.optString("url"))
                // `@JavascriptInterface` callbacks run off the UI thread; hop
                // back before emitting to the host webview.
                activity.runOnUiThread { trigger("message", payload) }
            } catch (error: Exception) {
                // Never propagate into the page.
            }
        }
    }
}
