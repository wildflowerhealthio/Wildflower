//! What each JNI export reports back to `HeadlessBridge`, as the JSON the
//! plugin's `HeadlessBridgeResult.fromJson` parses (`HeadlessBridge.kt`,
//! `tauri-plugin-background-service` 1.0.1):
//!
//! ```kotlin
//! val obj = JSONObject(json)
//! HeadlessBridgeResult(
//!     ok = obj.optBoolean("ok", false),
//!     state = obj.optString("state", "failed"),
//!     message = obj.optString("message").ifEmpty { null },
//!     recoverable = obj.optBoolean("recoverable", false),
//!     rawJson = json,
//! )
//! // …
//! val accepted: Boolean
//!     get() = ok
//! ```
//!
//! `ok` alone decides whether the plugin accepts the call; `state` and
//! `message` are diagnostics it logs and persists. A refusal takes the shape of
//! the plugin's own `HeadlessBridgeResult.failure(code, message)`:
//! `{"ok":false,"state":"failed","code":…,"message":…,"recoverable":…}`. The
//! plugin's notification-action handling treats a refusal that carries `code`
//! as permanent, so a refused notification action is dismissed, not re-shown.

use serde_json::json;

/// The answer to one `HeadlessBridge` call.
#[derive(Debug, PartialEq)]
pub(crate) enum HeadlessCoreReport {
    /// Accepted: the Tauri host's `BackgroundService` runs the server, so
    /// there is nothing for a headless core to do. `startCore` reports this
    /// once the host is running; `stopCore` and `notifyNetworkChanged` always
    /// do, since the host stops the server through the plugin's cancellation
    /// token and the server needs no network nudge.
    HostManaged,
    /// `startCore` with no Tauri host in this process: Android started the
    /// service on its own (after a boot, an app update or a sticky restart),
    /// and there is no server to keep alive.
    HostNotRunning,
    /// `callAction`: this app has no calls.
    NoCalls,
    /// `notificationAction`: this app posts no message notifications.
    NoMessageNotifications,
}

impl HeadlessCoreReport {
    /// The answer to `startCore`, given whether this process's Tauri host has
    /// marked itself running.
    pub(crate) fn for_start_core(host_is_running: bool) -> Self {
        if host_is_running {
            Self::HostManaged
        } else {
            Self::HostNotRunning
        }
    }

    /// The JSON `HeadlessBridgeResult.fromJson` parses.
    pub(crate) fn to_json(&self) -> String {
        let (code, message, recoverable) = match self {
            Self::HostManaged => return json!({ "ok": true, "state": "host_managed" }).to_string(),
            // Recoverable: opening the app starts the server.
            Self::HostNotRunning => (
                "host_not_running",
                "Android started the background service without the Wildflower app, which runs the server; open Wildflower to start it",
                true,
            ),
            Self::NoCalls => ("calls_not_supported", "Wildflower has no calls", false),
            Self::NoMessageNotifications => (
                "message_notifications_not_supported",
                "Wildflower posts no message notifications",
                false,
            ),
        };
        json!({
            "ok": false,
            "state": "failed",
            "code": code,
            "message": message,
            "recoverable": recoverable,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn parsed(report: &HeadlessCoreReport) -> Value {
        serde_json::from_str(&report.to_json()).expect("a report is JSON")
    }

    /// `HeadlessBridgeResult.accepted` is `optBoolean("ok", false)`.
    fn plugin_accepts(report: &HeadlessCoreReport) -> bool {
        parsed(report)["ok"].as_bool().unwrap_or(false)
    }

    #[test]
    fn start_core_is_accepted_only_once_the_host_is_running() {
        assert_eq!(
            HeadlessCoreReport::for_start_core(true),
            HeadlessCoreReport::HostManaged
        );
        assert_eq!(
            HeadlessCoreReport::for_start_core(false),
            HeadlessCoreReport::HostNotRunning
        );
        assert!(plugin_accepts(&HeadlessCoreReport::for_start_core(true)));
        assert!(!plugin_accepts(&HeadlessCoreReport::for_start_core(false)));
    }

    #[test]
    fn host_managed_is_accepted_with_only_ok_and_state() {
        assert_eq!(
            parsed(&HeadlessCoreReport::HostManaged),
            json!({ "ok": true, "state": "host_managed" })
        );
    }

    #[test]
    fn host_not_running_is_a_recoverable_failure() {
        assert_eq!(
            parsed(&HeadlessCoreReport::HostNotRunning),
            json!({
                "ok": false,
                "state": "failed",
                "code": "host_not_running",
                "message": "Android started the background service without the Wildflower app, which runs the server; open Wildflower to start it",
                "recoverable": true,
            })
        );
    }

    #[test]
    fn call_and_notification_actions_are_permanent_failures() {
        assert_eq!(
            parsed(&HeadlessCoreReport::NoCalls),
            json!({
                "ok": false,
                "state": "failed",
                "code": "calls_not_supported",
                "message": "Wildflower has no calls",
                "recoverable": false,
            })
        );
        assert_eq!(
            parsed(&HeadlessCoreReport::NoMessageNotifications),
            json!({
                "ok": false,
                "state": "failed",
                "code": "message_notifications_not_supported",
                "message": "Wildflower posts no message notifications",
                "recoverable": false,
            })
        );
    }

    /// The plugin spots a permanent refusal by scanning the raw JSON for the
    /// `"code":` key (`decideNotificationOutcome`), so the compact form must
    /// carry it with no space before the colon.
    #[test]
    fn every_refusal_carries_the_code_key_the_plugin_scans_for() {
        for refusal in [
            HeadlessCoreReport::HostNotRunning,
            HeadlessCoreReport::NoCalls,
            HeadlessCoreReport::NoMessageNotifications,
        ] {
            assert!(!plugin_accepts(&refusal));
            assert!(refusal.to_json().contains("\"code\":"), "{refusal:?}");
        }
    }
}
