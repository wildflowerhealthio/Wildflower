//! Serde mirror of `BackgroundServerServiceBridge`: the server service's status
//! snapshot (host → web) and the restart request (web → host).
//!
//! The TS schema in `background-server-service-core` is the contract the web
//! side decodes against; the golden tests below pin this side's exact bytes to
//! the wire strings the [Design Explanation](../../docs/Design%20Explanation.md)
//! documents. See the
//! [Wire Pinning How-To](../../../../docs/Messaging/Wire%20Pinning%20How-To.md).

use serde::{Deserialize, Serialize};

use crate::plugin_event::ServiceStopReason;
use crate::server_run::ServerRunState;

/// Host→web tag literal for [`BackgroundServerServiceHostToWeb::ServerServiceStatus`].
pub const SERVER_SERVICE_STATUS: &str = "ServerServiceStatus";

/// Web→host tag literal for [`BackgroundServerServiceWebToHost::RestartServer`],
/// for routing an envelope `_tag` peek before decoding.
pub const RESTART_SERVER: &str = "RestartServer";

/// Every tag this slice dispatches on the multiplexed bridge channel, in both
/// directions. The host's boot log reads from this list.
pub const TAGS: [&str; 2] = [SERVER_SERVICE_STATUS, RESTART_SERVER];

/// Host→web messages on the server service bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum BackgroundServerServiceHostToWeb {
    /// The service's current status. Emitted on every change and in reply to
    /// the page's `__Ready`; the page renders the latest one and keeps no state
    /// of its own.
    ///
    /// Wire: `{"_tag":"ServerServiceStatus","state":"running","stopReason":null,"lastError":null,"notifications":"granted"}`.
    ServerServiceStatus(ServerServiceStatus),
}

/// Web→host messages on the server service bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum BackgroundServerServiceWebToHost {
    /// Stop the server if it is running, then start it.
    ///
    /// Wire: `{"_tag":"RestartServer"}`.
    RestartServer,
}

/// The status snapshot the page renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerServiceStatus {
    /// Where the current run is.
    pub state: ServerServiceState,
    /// Why the most recent run stopped, as the plugin reported it; `null` until
    /// one has stopped.
    pub stop_reason: Option<ServiceStopReason>,
    /// The error the most recent run stopped with, as its full `{:#}` chain;
    /// `null` while a run is starting or running, or when it stopped cleanly.
    pub last_error: Option<String>,
    /// Whether the host may post notifications.
    pub notifications: NotificationPermission,
}

impl ServerServiceStatus {
    /// The snapshot of `run_state`, with the plugin's `last_stop_reason` and the
    /// current `notifications` permission.
    #[must_use]
    pub fn new(
        run_state: &ServerRunState,
        last_stop_reason: Option<ServiceStopReason>,
        notifications: NotificationPermission,
    ) -> Self {
        let (state, last_error) = match run_state {
            ServerRunState::Starting => (ServerServiceState::Starting, None),
            ServerRunState::Running => (ServerServiceState::Running, None),
            ServerRunState::Stopped { error } => (ServerServiceState::Stopped, error.clone()),
        };
        Self {
            state,
            stop_reason: last_stop_reason,
            last_error,
            notifications,
        }
    }
}

/// [`ServerRunState`] without its error, which the snapshot carries as
/// [`ServerServiceStatus::last_error`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerServiceState {
    Starting,
    Running,
    Stopped,
}

/// Whether the host may post notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationPermission {
    Granted,
    Denied,
    /// Not decided yet (the OS has not asked), or the host could not read it.
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::Value;

    fn status(
        state: ServerServiceState,
        stop_reason: Option<ServiceStopReason>,
        last_error: Option<&str>,
        notifications: NotificationPermission,
    ) -> BackgroundServerServiceHostToWeb {
        BackgroundServerServiceHostToWeb::ServerServiceStatus(ServerServiceStatus {
            state,
            stop_reason,
            last_error: last_error.map(str::to_owned),
            notifications,
        })
    }

    /// The `_tag` a message actually serializes with, read back out of the
    /// encoded JSON rather than restated as a second hand-written copy.
    fn encoded_tag(message: &impl Serialize) -> String {
        let encoded: Value = serde_json::to_value(message).expect("serialize");
        encoded
            .get("_tag")
            .and_then(Value::as_str)
            .expect("_tag")
            .to_owned()
    }

    /// The listener routes on these constants but decodes into the enums, so
    /// renaming either half alone would silently stop dispatching.
    #[test]
    fn tag_literals_match_the_serde_representation() {
        assert_eq!(
            encoded_tag(&status(
                ServerServiceState::Running,
                None,
                None,
                NotificationPermission::Granted
            )),
            SERVER_SERVICE_STATUS
        );
        assert_eq!(
            encoded_tag(&BackgroundServerServiceWebToHost::RestartServer),
            RESTART_SERVER
        );
        assert_eq!(TAGS, [SERVER_SERVICE_STATUS, RESTART_SERVER]);
    }

    /// Golden test: the running shape, every optional field `null`.
    #[test]
    fn a_running_status_serializes_to_the_pinned_wire_format() {
        assert_eq!(
            serde_json::to_string(&status(
                ServerServiceState::Running,
                None,
                None,
                NotificationPermission::Granted
            ))
            .expect("serialize"),
            r#"{"_tag":"ServerServiceStatus","state":"running","stopReason":null,"lastError":null,"notifications":"granted"}"#
        );
    }

    /// Golden test: the stopped shape, every optional field present.
    #[test]
    fn a_stopped_status_serializes_to_the_pinned_wire_format() {
        assert_eq!(
            serde_json::to_string(&status(
                ServerServiceState::Stopped,
                Some(ServiceStopReason::PlatformExpiration),
                Some("failed to bind to 127.0.0.1:8080: Address already in use"),
                NotificationPermission::Denied
            ))
            .expect("serialize"),
            r#"{"_tag":"ServerServiceStatus","state":"stopped","stopReason":"platformExpiration","lastError":"failed to bind to 127.0.0.1:8080: Address already in use","notifications":"denied"}"#
        );
    }

    /// Golden test: `starting` and `unknown`, the remaining enum strings.
    #[test]
    fn a_starting_status_serializes_to_the_pinned_wire_format() {
        assert_eq!(
            serde_json::to_string(&status(
                ServerServiceState::Starting,
                Some(ServiceStopReason::AppStop),
                None,
                NotificationPermission::Unknown
            ))
            .expect("serialize"),
            r#"{"_tag":"ServerServiceStatus","state":"starting","stopReason":"appStop","lastError":null,"notifications":"unknown"}"#
        );
    }

    /// Every stop reason's wire string — the plugin's own camelCase names.
    #[test]
    fn stop_reasons_serialize_to_the_plugin_names() {
        let cases = [
            (ServiceStopReason::UserStop, "userStop"),
            (ServiceStopReason::AppStop, "appStop"),
            (ServiceStopReason::PlatformTimeout, "platformTimeout"),
            (ServiceStopReason::PlatformExpiration, "platformExpiration"),
            (
                ServiceStopReason::NativeNotificationStop,
                "nativeNotificationStop",
            ),
            (ServiceStopReason::OsRestart, "osRestart"),
            (ServiceStopReason::BootRecovery, "bootRecovery"),
            (ServiceStopReason::TaskCompleted, "taskCompleted"),
            (ServiceStopReason::Error, "error"),
            (ServiceStopReason::ProcessExit, "processExit"),
        ];
        for (reason, wire) in cases {
            assert_eq!(
                serde_json::to_string(&reason).expect("serialize"),
                format!("\"{wire}\"")
            );
        }
    }

    /// The inbound direction: the exact string the TS side sends decodes.
    #[test]
    fn restart_server_deserializes_from_the_pinned_wire_format() {
        assert_eq!(
            serde_json::from_str::<BackgroundServerServiceWebToHost>(r#"{"_tag":"RestartServer"}"#)
                .expect("deserialize"),
            BackgroundServerServiceWebToHost::RestartServer
        );
    }

    /// The listener peeks the `_tag` first, so a sibling slice's message must
    /// not decode as ours.
    #[test]
    fn an_unknown_tag_fails_to_decode() {
        assert!(serde_json::from_str::<BackgroundServerServiceWebToHost>(
            r#"{"_tag":"SaveHar","fileName":"a.har","text":""}"#
        )
        .is_err());
    }

    #[test]
    fn the_snapshot_splits_the_run_state_into_state_and_error() {
        let stopped = ServerRunState::Stopped {
            error: Some("failed to open shared database".to_owned()),
        };
        assert_eq!(
            ServerServiceStatus::new(
                &stopped,
                Some(ServiceStopReason::TaskCompleted),
                NotificationPermission::Granted
            ),
            ServerServiceStatus {
                state: ServerServiceState::Stopped,
                stop_reason: Some(ServiceStopReason::TaskCompleted),
                last_error: Some("failed to open shared database".to_owned()),
                notifications: NotificationPermission::Granted,
            }
        );
        for (run_state, state) in [
            (ServerRunState::Starting, ServerServiceState::Starting),
            (ServerRunState::Running, ServerServiceState::Running),
            (
                ServerRunState::Stopped { error: None },
                ServerServiceState::Stopped,
            ),
        ] {
            let snapshot =
                ServerServiceStatus::new(&run_state, None, NotificationPermission::Unknown);
            assert_eq!(snapshot.state, state);
            assert_eq!(snapshot.last_error, None);
        }
    }

    fn stop_reason() -> impl Strategy<Value = ServiceStopReason> {
        prop_oneof![
            Just(ServiceStopReason::UserStop),
            Just(ServiceStopReason::AppStop),
            Just(ServiceStopReason::PlatformTimeout),
            Just(ServiceStopReason::PlatformExpiration),
            Just(ServiceStopReason::NativeNotificationStop),
            Just(ServiceStopReason::OsRestart),
            Just(ServiceStopReason::BootRecovery),
            Just(ServiceStopReason::TaskCompleted),
            Just(ServiceStopReason::Error),
            Just(ServiceStopReason::ProcessExit),
        ]
    }

    fn server_service_status() -> impl Strategy<Value = ServerServiceStatus> {
        (
            prop_oneof![
                Just(ServerServiceState::Starting),
                Just(ServerServiceState::Running),
                Just(ServerServiceState::Stopped),
            ],
            proptest::option::of(stop_reason()),
            proptest::option::of(".{0,120}"),
            prop_oneof![
                Just(NotificationPermission::Granted),
                Just(NotificationPermission::Denied),
                Just(NotificationPermission::Unknown),
            ],
        )
            .prop_map(|(state, stop_reason, last_error, notifications)| {
                ServerServiceStatus {
                    state,
                    stop_reason,
                    last_error,
                    notifications,
                }
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn server_service_status_round_trips(status in server_service_status()) {
            let message = BackgroundServerServiceHostToWeb::ServerServiceStatus(status);
            let encoded = serde_json::to_string(&message).expect("serialize");
            let decoded: BackgroundServerServiceHostToWeb =
                serde_json::from_str(&encoded).expect("deserialize");
            prop_assert_eq!(decoded, message);
        }
    }
}
