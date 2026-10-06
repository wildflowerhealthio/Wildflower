//! Serde mirror of the lifecycle events `tauri-plugin-background-service`
//! emits on [`BACKGROUND_SERVICE_EVENT`].
//!
//! The host decodes the event's JSON payload into these types at the boundary
//! rather than into the plugin's own `PluginEvent`, whose `#[non_exhaustive]`
//! enums would force a catch-all arm on every match. The plugin is pinned
//! (`=1.0.1`), and `background-server-service-tauri-rust` pins this mirror
//! against the plugin's own serializer.

use serde::{Deserialize, Serialize};

/// The Tauri event the plugin emits its [`BackgroundServiceEvent`]s on.
pub const BACKGROUND_SERVICE_EVENT: &str = "background-service://event";

/// A lifecycle event from the plugin's service runner.
///
/// Wire: `{"type":"started"}`, `{"type":"stopped","reason":"userStop"}`,
/// `{"type":"error","message":"Runtime error: …"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BackgroundServiceEvent {
    /// The service's `init` returned and its `run` is about to start.
    Started,
    /// A run ended: an explicit stop (its reason), or `run` returning `Ok`
    /// unprompted ([`ServiceStopReason::TaskCompleted`]).
    Stopped { reason: ServiceStopReason },
    /// A run ended because `init` or `run` returned an error, with no explicit
    /// stop pending. `message` is the plugin's `ServiceError` display.
    Error { message: String },
}

/// Why a run of the background service stopped, as the plugin names it.
///
/// Also the `stopReason` of the bridge's `ServerServiceStatus`, so the page
/// sees the plugin's own camelCase names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceStopReason {
    /// A stop through the plugin's `stop` (the desktop app quitting included).
    UserStop,
    /// The host stopped the service itself, to restart it or because the base
    /// asked. Nothing in the plugin stops with this reason (see
    /// [`HOST_STOP_REASON`](crate::domain::stop_notification::HOST_STOP_REASON)).
    AppStop,
    /// The platform's foreground-service time limit ran out (Android).
    PlatformTimeout,
    /// The platform ended the background execution window (an iOS `BGTask`).
    PlatformExpiration,
    /// The Stop action on the foreground-service notification (Android).
    NativeNotificationStop,
    /// The OS restarted the service.
    OsRestart,
    /// The service came back after the device booted.
    BootRecovery,
    /// The service's `run` returned `Ok` with no stop pending.
    TaskCompleted,
    /// A stop recorded as an error.
    Error,
    /// The host process is going away (the iOS app backgrounded or killed).
    ProcessExit,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three event shapes the host listens for, decoded from the exact
    /// strings the plugin emits.
    #[test]
    fn events_decode_from_the_plugin_wire_format() {
        assert_eq!(
            serde_json::from_str::<BackgroundServiceEvent>(r#"{"type":"started"}"#)
                .expect("decode"),
            BackgroundServiceEvent::Started
        );
        assert_eq!(
            serde_json::from_str::<BackgroundServiceEvent>(
                r#"{"type":"stopped","reason":"platformExpiration"}"#
            )
            .expect("decode"),
            BackgroundServiceEvent::Stopped {
                reason: ServiceStopReason::PlatformExpiration
            }
        );
        assert_eq!(
            serde_json::from_str::<BackgroundServiceEvent>(
                r#"{"type":"error","message":"Runtime error: failed to bind"}"#
            )
            .expect("decode"),
            BackgroundServiceEvent::Error {
                message: "Runtime error: failed to bind".to_owned()
            }
        );
    }

    /// A reason this mirror doesn't know is a decode failure, never a guess.
    #[test]
    fn an_unknown_stop_reason_fails_to_decode() {
        assert!(serde_json::from_str::<BackgroundServiceEvent>(
            r#"{"type":"stopped","reason":"somethingNew"}"#
        )
        .is_err());
    }
}
