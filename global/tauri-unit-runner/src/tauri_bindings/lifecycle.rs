//! The runner's lifecycle plugin: the app's use and resumes from its window
//! events, the lease's end reasons from the background-service plugin's
//! events, and the lease driver from the moment the app is ready.

use std::sync::{Arc, PoisonError};

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Listener, RunEvent, Runtime, WindowEvent};
use tauri_plugin_background_service::PluginEvent;

use super::lease_end_pairing::{LeaseTaskEnd, BACKGROUND_SERVICE_EVENT};
use super::plugin_lease::PluginLease;
use super::UNIT_RUNNER_PLUGIN_NAME;
use crate::domain::use_signals::{UseSignals, UseUpdate};
use crate::runner::lease_driver::drive_lease;
use crate::unit_runner::UnitRunner;

/// The lifecycle plugin for `runner`.
pub(super) fn plugin<R: Runtime, D: Clone + Send + Sync + 'static>(
    runner: UnitRunner<D>,
) -> TauriPlugin<R> {
    let on_setup = runner.clone();
    let on_window_ready = runner.clone();
    tauri::plugin::Builder::new(UNIT_RUNNER_PLUGIN_NAME)
        .setup(move |app, _api| {
            listen_for_lease_task_ends(app, &on_setup);
            Ok(())
        })
        .on_window_ready(move |window| {
            on_window_ready.apply_use_signal(|signals| signals.window_opened(window.label()));
        })
        .on_event(move |app, event| runner.follow_run_event(app, event))
        .build()
}

/// Hand each lease-task end the background-service plugin reports to the lease
/// task waiting for its reason.
fn listen_for_lease_task_ends<R: Runtime, D: Clone + Send + Sync + 'static>(
    app: &AppHandle<R>,
    runner: &UnitRunner<D>,
) {
    let bindings = Arc::clone(&runner.bindings);
    app.listen(
        BACKGROUND_SERVICE_EVENT,
        move |event| match serde_json::from_str::<PluginEvent>(event.payload()) {
            Ok(plugin_event) => {
                if let Some(end) = LeaseTaskEnd::from_plugin_event(&plugin_event) {
                    bindings.lease_end_pairing.deliver(end);
                }
            }
            Err(error) => {
                log::warn!("[unit-runner] undecodable {BACKGROUND_SERVICE_EVENT} payload: {error}")
            }
        },
    );
}

impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    /// Follow the app's run events: start the lease driver once the app is
    /// ready, and follow window destruction, and suspend and resume on a
    /// phone.
    ///
    /// The window events, not `RunEvent::Resumed`: tauri-runtime-wry raises
    /// that one on an event-loop poll, not when the app comes back.
    fn follow_run_event<R: Runtime>(&self, app: &AppHandle<R>, event: &RunEvent) {
        match event {
            RunEvent::Ready => {
                let platform = Arc::new(PluginLease::new(
                    app.clone(),
                    self.bindings.start_config.clone(),
                ));
                self.core
                    .runtime()
                    .spawn(drive_lease(Arc::clone(&self.core), platform));
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => self.apply_use_signal(|signals| signals.window_destroyed(label)),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            RunEvent::WindowEvent {
                event: WindowEvent::Suspended,
                ..
            } => self.apply_use_signal(UseSignals::suspended),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            RunEvent::WindowEvent {
                event: WindowEvent::Resumed,
                ..
            } => self.apply_use_signal(UseSignals::resumed),
            _ => {}
        }
    }

    /// Record a window signal, and pass what it means on to the runner. Running
    /// units restart first, so units the change starts aren't restarted too.
    fn apply_use_signal(&self, signal: impl FnOnce(&mut UseSignals) -> UseUpdate) {
        let update = {
            // Each signal is one set insert or flag write, which no panic
            // leaves half-done.
            let mut signals = self
                .bindings
                .use_signals
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            signal(&mut signals)
        };
        if update.restart_running_units {
            self.core.restart_running_units();
        }
        self.core.set_in_use(update.in_use);
    }
}
