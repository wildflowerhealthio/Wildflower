//! The plugin's own `StopReason` for each [`ServiceStopReason`], and the tests
//! that pin the `background-server-service-rust` event mirror against the
//! plugin's serializer.

use background_server_service_rust::ServiceStopReason;
use tauri_plugin_background_service::models::StopReason;

/// The plugin's `StopReason` the host stops the service with for `reason`.
pub(crate) fn to_plugin(reason: ServiceStopReason) -> StopReason {
    match reason {
        ServiceStopReason::UserStop => StopReason::UserStop,
        ServiceStopReason::AppStop => StopReason::AppStop,
        ServiceStopReason::PlatformTimeout => StopReason::PlatformTimeout,
        ServiceStopReason::PlatformExpiration => StopReason::PlatformExpiration,
        ServiceStopReason::NativeNotificationStop => StopReason::NativeNotificationStop,
        ServiceStopReason::OsRestart => StopReason::OsRestart,
        ServiceStopReason::BootRecovery => StopReason::BootRecovery,
        ServiceStopReason::TaskCompleted => StopReason::TaskCompleted,
        ServiceStopReason::Error => StopReason::Error,
        ServiceStopReason::ProcessExit => StopReason::ProcessExit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use background_server_service_rust::BackgroundServiceEvent;
    use tauri_plugin_background_service::PluginEvent;

    /// Every reason the plugin emits, as the plugin's own type. Its enum is
    /// `#[non_exhaustive]`, so this list is checked from the other side too:
    /// [`to_plugin`] is exhaustive over the mirror, and each mirror reason must
    /// map onto a distinct entry here.
    const PLUGIN_STOP_REASONS: [StopReason; 10] = [
        StopReason::UserStop,
        StopReason::AppStop,
        StopReason::PlatformTimeout,
        StopReason::PlatformExpiration,
        StopReason::NativeNotificationStop,
        StopReason::OsRestart,
        StopReason::BootRecovery,
        StopReason::TaskCompleted,
        StopReason::Error,
        StopReason::ProcessExit,
    ];

    /// The plugin serializes each `Stopped` event; the mirror decodes it, and
    /// mapping the decoded reason back gives the reason the plugin sent.
    #[test]
    fn every_plugin_stop_event_decodes_into_the_mirror() {
        for plugin_reason in PLUGIN_STOP_REASONS {
            let encoded = serde_json::to_string(&PluginEvent::Stopped {
                reason: plugin_reason,
            })
            .expect("the plugin serializes its event");
            let decoded: BackgroundServiceEvent =
                serde_json::from_str(&encoded).expect("the mirror decodes the plugin's event");
            let BackgroundServiceEvent::Stopped { reason } = decoded else {
                panic!("{encoded} decoded as {decoded:?}");
            };
            assert_eq!(to_plugin(reason), plugin_reason);
        }
    }

    #[test]
    fn the_plugin_s_started_and_error_events_decode_into_the_mirror() {
        let started = serde_json::to_string(&PluginEvent::Started).expect("serialize");
        assert_eq!(
            serde_json::from_str::<BackgroundServiceEvent>(&started).expect("decode"),
            BackgroundServiceEvent::Started
        );
        let error = serde_json::to_string(&PluginEvent::Error {
            message: "Runtime error: failed to bind".to_owned(),
        })
        .expect("serialize");
        assert_eq!(
            serde_json::from_str::<BackgroundServiceEvent>(&error).expect("decode"),
            BackgroundServiceEvent::Error {
                message: "Runtime error: failed to bind".to_owned()
            }
        );
    }

    /// The mirror's own serialization is the plugin's, reason for reason — the
    /// page reads the snapshot's `stopReason` with the plugin's names.
    #[test]
    fn the_mirror_serializes_each_reason_as_the_plugin_does() {
        let mirror_reasons = [
            ServiceStopReason::UserStop,
            ServiceStopReason::AppStop,
            ServiceStopReason::PlatformTimeout,
            ServiceStopReason::PlatformExpiration,
            ServiceStopReason::NativeNotificationStop,
            ServiceStopReason::OsRestart,
            ServiceStopReason::BootRecovery,
            ServiceStopReason::TaskCompleted,
            ServiceStopReason::Error,
            ServiceStopReason::ProcessExit,
        ];
        for reason in mirror_reasons {
            assert_eq!(
                serde_json::to_string(&reason).expect("serialize the mirror"),
                serde_json::to_string(&to_plugin(reason)).expect("serialize the plugin's")
            );
        }
    }
}
