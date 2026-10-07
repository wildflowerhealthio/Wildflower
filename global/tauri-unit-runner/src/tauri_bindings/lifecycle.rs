//! The runner's lifecycle plugin: whether the app is open, and its resumes,
//! from its window events; the keep-alive's end reasons from the
//! background-service plugin's events; and the keep-alive sync from the moment
//! the app is ready.

use std::sync::{Arc, PoisonError};

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Listener, RunEvent, Runtime, WindowEvent};
use tauri_plugin_background_service::PluginEvent as BackgroundServicePluginEvent;

use super::keep_alive_end_pairing::{KeepAliveTaskEnd, BACKGROUND_SERVICE_EVENT};
use super::plugin_keep_alive::PluginKeepAlive;
use super::UNIT_RUNNER_PLUGIN_NAME;
use crate::domain::window_state::{WindowState, WindowStateChange};
use crate::runner::UnitRunner;

/// The lifecycle plugin for `runner`.
pub(super) fn plugin<R: Runtime, D: Clone + Send + Sync + 'static>(
    runner: UnitRunner<D>,
) -> TauriPlugin<R> {
    let on_setup = runner.clone();
    let on_window_ready = runner.clone();
    tauri::plugin::Builder::new(UNIT_RUNNER_PLUGIN_NAME)
        .setup(move |app, _api| {
            listen_for_keep_alive_task_ends(app, &on_setup);
            Ok(())
        })
        .on_window_ready(move |window| {
            on_window_ready.apply_window_event(|windows| windows.window_opened(window.label()));
        })
        .on_event(move |app, event| runner.follow_run_event(app, event))
        .build()
}

/// Hand each keep-alive task end the background-service plugin reports to the
/// keep-alive task waiting for its reason.
fn listen_for_keep_alive_task_ends<R: Runtime, D: Clone + Send + Sync + 'static>(
    app: &AppHandle<R>,
    runner: &UnitRunner<D>,
) {
    let bindings = Arc::clone(&runner.bindings);
    app.listen(
        BACKGROUND_SERVICE_EVENT,
        move |event| match serde_json::from_str::<BackgroundServicePluginEvent>(event.payload()) {
            Ok(plugin_event) => {
                if let Some(end) = KeepAliveTaskEnd::from_plugin_event(&plugin_event) {
                    bindings.keep_alive_end_pairing.deliver(end);
                }
            }
            Err(error) => {
                log::warn!("[unit-runner] undecodable {BACKGROUND_SERVICE_EVENT} payload: {error}")
            }
        },
    );
}

impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    /// Follow the app's run events: start the keep-alive sync once the app is
    /// ready, and follow window destruction, and suspend and resume on a
    /// phone.
    ///
    /// The window events, not `RunEvent::Resumed`: tauri-runtime-wry raises
    /// that one on an event-loop poll, not when the app comes back.
    fn follow_run_event<R: Runtime>(&self, app: &AppHandle<R>, event: &RunEvent) {
        match event {
            RunEvent::Ready => {
                let platform = Arc::new(PluginKeepAlive::new(
                    app.clone(),
                    self.bindings.start_config.clone(),
                ));
                self.core.start_keep_alive_sync(platform);
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => self.apply_window_event(|windows| windows.window_destroyed(label)),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            RunEvent::WindowEvent {
                event: WindowEvent::Suspended,
                ..
            } => self.apply_window_event(WindowState::suspended),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            RunEvent::WindowEvent {
                event: WindowEvent::Resumed,
                ..
            } => self.apply_window_event(WindowState::resumed),
            _ => {}
        }
    }

    /// Record a window event, and pass what it means on to the runner. Running
    /// units restart first, so units the change starts aren't restarted too.
    fn apply_window_event(&self, event: impl FnOnce(&mut WindowState) -> WindowStateChange) {
        let change = {
            // Each event is one set insert or flag write, which no panic
            // leaves half-done.
            let mut windows = self
                .bindings
                .window_state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            event(&mut windows)
        };
        if change.unit_restarts_needed {
            self.core.restart_running_units();
        }
        self.core.set_app_open(change.open_after_event);
    }
}
