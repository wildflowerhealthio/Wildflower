package io.wildflowerhealth.nativepagebrowser

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder

/**
 * The service a Custom Tab's browser binds while the tab is open, named by the
 * keep-alive extra [NativePageBrowserPlugin] launches each tab with. The
 * binding is the point: Android ranks the app as high as the bound-by browser
 * in front, so it doesn't treat the app as in the background or cut its
 * network. It does nothing for the browser beyond accepting the binding, and
 * tells the plugin it happened through [onBound].
 */
class KeepAliveService : Service() {
    companion object {
        /** Called on the main thread when a browser binds the service. */
        var onBound: (() -> Unit)? = null
    }

    override fun onBind(intent: Intent?): IBinder {
        onBound?.invoke()
        return Binder()
    }
}
