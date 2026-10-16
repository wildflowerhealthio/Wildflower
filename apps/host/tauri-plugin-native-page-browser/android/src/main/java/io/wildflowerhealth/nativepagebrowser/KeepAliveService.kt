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
 * tells the plugin through [onBound] and [onUnbound] each time a browser
 * binds it and the last one lets it go. Chrome holds the binding while a tab
 * is started, so it lets go as the user leaves the tab for the home screen or
 * another app, or closes the last tab, and binds again as the tab comes back.
 */
class KeepAliveService : Service() {
    companion object {
        /** Called on the main thread when a browser binds the service, again included. */
        var onBound: (() -> Unit)? = null

        /** Called on the main thread when the last browser bound lets the service go. */
        var onUnbound: (() -> Unit)? = null
    }

    override fun onBind(intent: Intent?): IBinder {
        onBound?.invoke()
        return Binder()
    }

    override fun onRebind(intent: Intent?) {
        onBound?.invoke()
    }

    /** Returns `true`, so a browser binding the service again calls [onRebind]. */
    override fun onUnbind(intent: Intent?): Boolean {
        onUnbound?.invoke()
        return true
    }
}
