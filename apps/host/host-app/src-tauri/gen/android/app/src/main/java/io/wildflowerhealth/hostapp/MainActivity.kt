package io.wildflowerhealth.hostapp

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // Before `super`, under which tauri-plugin-notification reads the intent
    // that started the activity.
    withTappedNotificationId(intent)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    withTappedNotificationId(intent)
    super.onNewIntent(intent)
  }
}

/**
 * The extras tauri-plugin-notification (2.x, `TauriNotificationManager.kt`)
 * puts on the intent a tap on one of its notifications starts the activity
 * with: the notification's id, and the notification as JSON, which it reports
 * as the `notification` of its `actionPerformed` event.
 */
private const val NOTIFICATION_ID_EXTRA = "NotificationId"
private const val NOTIFICATION_OBJECT_EXTRA = "LocalNotficationObject"

/**
 * Fill the notification-object extra of `intent`, a tapped notification's,
 * with `{"id": …}` from its id extra. The plugin never fills that extra on
 * Android, so its `actionPerformed` reports `notification: null`, and the base,
 * which finds the tapped consent by `notification.id`, can't tell which
 * notification was tapped. Any other intent is left as it is.
 */
private fun withTappedNotificationId(intent: Intent?) {
  if (intent == null || intent.getStringExtra(NOTIFICATION_OBJECT_EXTRA) != null) return
  val id = intent.getIntExtra(NOTIFICATION_ID_EXTRA, Int.MIN_VALUE)
  if (id == Int.MIN_VALUE) return
  intent.putExtra(NOTIFICATION_OBJECT_EXTRA, JSONObject().put("id", id).toString())
}
