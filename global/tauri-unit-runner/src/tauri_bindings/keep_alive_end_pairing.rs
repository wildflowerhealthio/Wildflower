//! Pairing each keep-alive task's end with the reason the background-service
//! plugin gives for it.
//!
//! The service's task sees only its shutdown token; the reason comes on the
//! plugin's `background-service://event`, emitted just after the task returns.
//! The task leaves a waiter here as it returns, and the event listener hands
//! the reason to it.

use std::sync::{Mutex, PoisonError};

use tauri_plugin_background_service::models::StopReason;
use tauri_plugin_background_service::PluginEvent;
use tokio::sync::oneshot;
use unit_runner::PlatformStopReason;

/// The Tauri event the plugin emits its [`PluginEvent`]s on.
pub(crate) const BACKGROUND_SERVICE_EVENT: &str = "background-service://event";

/// The reason the runner stops the keep-alive task with. The plugin never stops
/// the service with it itself (its own stops are `UserStop`, the platform's,
/// `TaskCompleted` and `Error`), so its end is never taken for the platform's.
pub(crate) const RUNNER_RELEASE_STOP_REASON: StopReason = StopReason::AppStop;

/// How a keep-alive task ended, by the plugin's account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeepAliveTaskEnd {
    /// The runner stopped it.
    Released,
    /// Anything else, for this reason.
    Platform(PlatformStopReason),
}

impl KeepAliveTaskEnd {
    /// The platform's reason, unless the runner stopped the task.
    pub(crate) fn platform_reason(self) -> Option<PlatformStopReason> {
        match self {
            Self::Released => None,
            Self::Platform(platform_reason) => Some(platform_reason),
        }
    }

    /// How the keep-alive task that `event` reports on ended, or `None` when
    /// the event isn't an end.
    pub(crate) fn from_plugin_event(event: &PluginEvent) -> Option<Self> {
        match event {
            PluginEvent::Stopped { reason } if *reason == RUNNER_RELEASE_STOP_REASON => {
                Some(Self::Released)
            }
            PluginEvent::Stopped { reason } => Some(Self::Platform(platform_stop_reason(*reason))),
            PluginEvent::Error { .. } => Some(Self::Platform(PlatformStopReason::Error)),
            // `PluginEvent` is `#[non_exhaustive]`: an event added later
            // doesn't end a task.
            _ => None,
        }
    }
}

/// The runner's name for the plugin's `reason`. The runner's own
/// [`RUNNER_RELEASE_STOP_REASON`] never gets here; a reason added to the plugin
/// later is [`PlatformStopReason::Unknown`].
fn platform_stop_reason(reason: StopReason) -> PlatformStopReason {
    match reason {
        StopReason::UserStop => PlatformStopReason::UserStop,
        StopReason::PlatformTimeout => PlatformStopReason::PlatformTimeout,
        StopReason::PlatformExpiration => PlatformStopReason::PlatformExpiration,
        StopReason::NativeNotificationStop => PlatformStopReason::NativeNotificationStop,
        StopReason::OsRestart => PlatformStopReason::OsRestart,
        StopReason::BootRecovery => PlatformStopReason::BootRecovery,
        StopReason::TaskCompleted => PlatformStopReason::TaskCompleted,
        StopReason::Error => PlatformStopReason::Error,
        StopReason::ProcessExit => PlatformStopReason::ProcessExit,
        _ => PlatformStopReason::Unknown,
    }
}

/// The waiter the most recently ended keep-alive task left for its reason.
#[derive(Default)]
pub(crate) struct KeepAliveEndPairing {
    waiting_tx: Mutex<Option<oneshot::Sender<KeepAliveTaskEnd>>>,
}

impl KeepAliveEndPairing {
    /// Wait for the next keep-alive task end the plugin reports. Replaces an
    /// earlier waiter, which then gets nothing.
    pub(crate) fn wait_for_end(&self) -> oneshot::Receiver<KeepAliveTaskEnd> {
        let (end_tx, end_rx) = oneshot::channel();
        *self.lock() = Some(end_tx);
        end_rx
    }

    /// Hand `end` to the keep-alive task waiting for it, if one is.
    pub(crate) fn deliver(&self, end: KeepAliveTaskEnd) {
        match self.lock().take() {
            Some(end_tx) => {
                // A waiter that gave up has already reported its end.
                let _waiter_gone = end_tx.send(end);
            }
            None => {
                log::debug!("[unit-runner] keep-alive end {end:?} with no keep-alive task waiting");
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<KeepAliveTaskEnd>>> {
        // Replacing or taking one value can't be left half-done by a panic.
        self.waiting_tx
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every stop reason the plugin has, as of the pinned version.
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

    /// Decode `event` the way the listener does: from the plugin's own JSON.
    fn decoded(event: &PluginEvent) -> PluginEvent {
        let payload = serde_json::to_string(event).expect("the plugin serializes its event");
        serde_json::from_str(&payload).expect("the plugin's event decodes")
    }

    #[test]
    fn only_the_runner_s_own_reason_reads_as_its_release() {
        for reason in PLUGIN_STOP_REASONS {
            let end =
                KeepAliveTaskEnd::from_plugin_event(&decoded(&PluginEvent::Stopped { reason }));
            if reason == RUNNER_RELEASE_STOP_REASON {
                assert_eq!(end, Some(KeepAliveTaskEnd::Released));
            } else {
                let Some(KeepAliveTaskEnd::Platform(platform_reason)) = end else {
                    panic!("{reason:?} read as {end:?}");
                };
                assert_ne!(platform_reason, PlatformStopReason::Unknown, "{reason:?}");
            }
        }
    }

    #[test]
    fn each_platform_reason_keeps_its_own_name() {
        let names: std::collections::HashSet<_> = PLUGIN_STOP_REASONS
            .into_iter()
            .filter(|reason| *reason != RUNNER_RELEASE_STOP_REASON)
            .map(platform_stop_reason)
            .collect();
        assert_eq!(names.len(), PLUGIN_STOP_REASONS.len() - 1);
    }

    #[test]
    fn an_error_ends_the_task_and_a_start_doesn_t() {
        assert_eq!(
            KeepAliveTaskEnd::from_plugin_event(&decoded(&PluginEvent::Error {
                message: "Runtime error: gone".to_owned()
            })),
            Some(KeepAliveTaskEnd::Platform(PlatformStopReason::Error))
        );
        assert_eq!(
            KeepAliveTaskEnd::from_plugin_event(&decoded(&PluginEvent::Started)),
            None
        );
    }

    #[test]
    fn the_end_goes_to_the_latest_waiter() {
        let pairing = KeepAliveEndPairing::default();
        let mut replaced_rx = pairing.wait_for_end();
        let mut latest_rx = pairing.wait_for_end();
        pairing.deliver(KeepAliveTaskEnd::Released);
        assert!(replaced_rx.try_recv().is_err());
        assert_eq!(latest_rx.try_recv(), Ok(KeepAliveTaskEnd::Released));
        // With nobody waiting, an end is dropped.
        pairing.deliver(KeepAliveTaskEnd::Released);
    }
}
