//! Pairing each background session's end with the reason the
//! background-service plugin gives for it.
//!
//! The service's task sees only its shutdown token; the reason comes on the
//! plugin's `background-service://event`, emitted just after the task returns.
//! The task leaves a waiter here as it returns, and the event listener hands
//! the reason to it.

use std::sync::{Mutex, PoisonError};

use tauri_plugin_background_service::models::StopReason as TauriBackgroundServiceStopReason;
use tauri_plugin_background_service::PluginEvent as BackgroundServicePluginEvent;
use tokio::sync::oneshot;
use unit_runner::PlatformStopReason;

/// The Tauri event the plugin emits its [`BackgroundServicePluginEvent`]s on.
pub(crate) const BACKGROUND_SERVICE_EVENT: &str = "background-service://event";

/// The reason the runner ends a background session with once no unit should
/// run. The plugin never stops the service with it itself (its own stops are
/// `UserStop`, the platform's, `TaskCompleted` and `Error`), so that end is
/// never taken for the platform's.
pub(crate) const NO_LONGER_NEEDED_STOP_REASON: TauriBackgroundServiceStopReason =
    TauriBackgroundServiceStopReason::AppStop;

/// How a background session ended, by the plugin's account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PluginSessionEnd {
    /// The runner ended it, because no unit should run.
    NoLongerNeeded,
    /// Anything else ended it, for this reason.
    EndedByPlatform(PlatformStopReason),
}

impl PluginSessionEnd {
    /// The platform's reason, unless the runner ended the session.
    pub(crate) fn platform_reason(self) -> Option<PlatformStopReason> {
        match self {
            Self::NoLongerNeeded => None,
            Self::EndedByPlatform(platform_reason) => Some(platform_reason),
        }
    }

    /// How the background session that `event` reports on ended, or `None`
    /// when the event isn't an end.
    pub(crate) fn from_plugin_event(event: &BackgroundServicePluginEvent) -> Option<Self> {
        match event {
            BackgroundServicePluginEvent::Stopped { reason }
                if *reason == NO_LONGER_NEEDED_STOP_REASON =>
            {
                Some(Self::NoLongerNeeded)
            }
            BackgroundServicePluginEvent::Stopped { reason } => {
                Some(Self::EndedByPlatform(platform_stop_reason(*reason)))
            }
            BackgroundServicePluginEvent::Error { .. } => {
                Some(Self::EndedByPlatform(PlatformStopReason::Error))
            }
            // `BackgroundServicePluginEvent` is `#[non_exhaustive]`: an event
            // added later doesn't end a session.
            _ => None,
        }
    }
}

/// The runner's name for the plugin's `reason`. The runner's own
/// [`NO_LONGER_NEEDED_STOP_REASON`] never gets here; a reason added to the
/// plugin later is [`PlatformStopReason::Unknown`].
fn platform_stop_reason(reason: TauriBackgroundServiceStopReason) -> PlatformStopReason {
    match reason {
        TauriBackgroundServiceStopReason::UserStop => PlatformStopReason::UserStop,
        TauriBackgroundServiceStopReason::PlatformTimeout => PlatformStopReason::PlatformTimeout,
        TauriBackgroundServiceStopReason::PlatformExpiration => {
            PlatformStopReason::PlatformExpiration
        }
        TauriBackgroundServiceStopReason::NativeNotificationStop => {
            PlatformStopReason::NativeNotificationStop
        }
        TauriBackgroundServiceStopReason::OsRestart => PlatformStopReason::OsRestart,
        TauriBackgroundServiceStopReason::BootRecovery => PlatformStopReason::BootRecovery,
        TauriBackgroundServiceStopReason::TaskCompleted => PlatformStopReason::TaskCompleted,
        TauriBackgroundServiceStopReason::Error => PlatformStopReason::Error,
        TauriBackgroundServiceStopReason::ProcessExit => PlatformStopReason::ProcessExit,
        _ => PlatformStopReason::Unknown,
    }
}

/// The waiter the most recently ended background session left for its reason.
#[derive(Default)]
pub(crate) struct SessionEndPairing {
    waiting_tx: Mutex<Option<oneshot::Sender<PluginSessionEnd>>>,
}

impl SessionEndPairing {
    /// Wait for the next background session end the plugin reports. Replaces an
    /// earlier waiter, which then gets nothing.
    pub(crate) fn wait_for_end(&self) -> oneshot::Receiver<PluginSessionEnd> {
        let (end_tx, end_rx) = oneshot::channel();
        *self.lock_waiting_tx() = Some(end_tx);
        end_rx
    }

    /// Hand `end` to the background session waiting for it, if one is.
    pub(crate) fn deliver(&self, end: PluginSessionEnd) {
        match self.lock_waiting_tx().take() {
            Some(end_tx) => {
                // A waiter that gave up has already reported its end.
                let _waiter_gone = end_tx.send(end);
            }
            None => {
                log::debug!("[unit-runner] session end {end:?} with no background session waiting");
            }
        }
    }

    fn lock_waiting_tx(
        &self,
    ) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<PluginSessionEnd>>> {
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
    const PLUGIN_STOP_REASONS: [TauriBackgroundServiceStopReason; 10] = [
        TauriBackgroundServiceStopReason::UserStop,
        TauriBackgroundServiceStopReason::AppStop,
        TauriBackgroundServiceStopReason::PlatformTimeout,
        TauriBackgroundServiceStopReason::PlatformExpiration,
        TauriBackgroundServiceStopReason::NativeNotificationStop,
        TauriBackgroundServiceStopReason::OsRestart,
        TauriBackgroundServiceStopReason::BootRecovery,
        TauriBackgroundServiceStopReason::TaskCompleted,
        TauriBackgroundServiceStopReason::Error,
        TauriBackgroundServiceStopReason::ProcessExit,
    ];

    /// Decode `event` the way the listener does: from the plugin's own JSON.
    fn decoded(event: &BackgroundServicePluginEvent) -> BackgroundServicePluginEvent {
        let payload = serde_json::to_string(event).expect("the plugin serializes its event");
        serde_json::from_str(&payload).expect("the plugin's event decodes")
    }

    #[test]
    fn only_the_runner_s_own_reason_reads_as_no_longer_needed() {
        for reason in PLUGIN_STOP_REASONS {
            let end = PluginSessionEnd::from_plugin_event(&decoded(
                &BackgroundServicePluginEvent::Stopped { reason },
            ));
            if reason == NO_LONGER_NEEDED_STOP_REASON {
                assert_eq!(end, Some(PluginSessionEnd::NoLongerNeeded));
            } else {
                let Some(PluginSessionEnd::EndedByPlatform(platform_reason)) = end else {
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
            .filter(|reason| *reason != NO_LONGER_NEEDED_STOP_REASON)
            .map(platform_stop_reason)
            .collect();
        assert_eq!(names.len(), PLUGIN_STOP_REASONS.len() - 1);
    }

    #[test]
    fn an_error_ends_the_session_and_a_start_doesn_t() {
        assert_eq!(
            PluginSessionEnd::from_plugin_event(&decoded(&BackgroundServicePluginEvent::Error {
                message: "Runtime error: gone".to_owned()
            })),
            Some(PluginSessionEnd::EndedByPlatform(PlatformStopReason::Error))
        );
        assert_eq!(
            PluginSessionEnd::from_plugin_event(&decoded(&BackgroundServicePluginEvent::Started)),
            None
        );
    }

    #[test]
    fn the_end_goes_to_the_latest_waiter() {
        let pairing = SessionEndPairing::default();
        let mut replaced_rx = pairing.wait_for_end();
        let mut latest_rx = pairing.wait_for_end();
        pairing.deliver(PluginSessionEnd::NoLongerNeeded);
        assert!(replaced_rx.try_recv().is_err());
        assert_eq!(latest_rx.try_recv(), Ok(PluginSessionEnd::NoLongerNeeded));
        // With nobody waiting, an end is dropped.
        pairing.deliver(PluginSessionEnd::NoLongerNeeded);
    }
}
