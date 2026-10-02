package io.wildflowerhealth.hostapp

import android.app.Application
import app.tauri.backgroundservice.HeadlessBridge

/**
 * Points the background-service plugin's [HeadlessBridge] at the host's
 * library, which exports the JNI functions its foreground service calls
 * (`background-server-service-android-rust`, removed with #886).
 *
 * Set here rather than in [MainActivity] because Android also starts the
 * foreground service in a process with no Activity (after a boot, an app
 * update or a sticky restart), and [HeadlessBridge] caches the first load it
 * attempts: a failed load of its default library would keep failing after the
 * user opens the app in the same process. `Application.onCreate` runs before
 * any service, receiver or Activity in the process.
 */
class WildflowerApplication : Application() {
  override fun onCreate() {
    HeadlessBridge.nativeLibName = "wildflower_tauri_lib"
    super.onCreate()
  }
}
