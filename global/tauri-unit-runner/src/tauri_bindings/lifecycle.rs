//! `TauriUnitRunner`'s lifecycle plugin: whether the app is present, and its
//! returns to the foreground, from its window events; the background session's
//! end reasons from the background-service plugin's events; and driving the
//! background session from the moment the app is ready.

use std::sync::{Arc, PoisonError};

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Listener, RunEvent, Runtime, WindowEvent};
use tauri_plugin_background_service::PluginEvent as BackgroundServicePluginEvent;

use super::plugin_background_session::PluginBackgroundSession;
use super::session_end_pairing::{PluginSessionEnd, BACKGROUND_SERVICE_EVENT};
use super::UNIT_RUNNER_PLUGIN_NAME;
use crate::domain::window_state::{WindowState, WindowStateChange};
use crate::tauri_unit_runner::TauriUnitRunner;

/// The lifecycle plugin for `runner`.
pub(super) fn plugin<R: Runtime, D: Clone + Send + Sync + 'static>(
    runner: TauriUnitRunner<D>,
) -> TauriPlugin<R> {
    let on_setup = runner.clone();
    let on_window_ready = runner.clone();
    tauri::plugin::Builder::new(UNIT_RUNNER_PLUGIN_NAME)
        .setup(move |app, _api| {
            listen_for_session_ends(app, &on_setup);
            Ok(())
        })
        .on_window_ready(move |window| {
            on_window_ready
                .record_window_event(|window_state| window_state.window_opened(window.label()));
        })
        .on_event(move |app, event| runner.follow_run_event(app, event))
        .build()
}

/// Hand each background session end the background-service plugin reports to
/// the session waiting for its reason.
fn listen_for_session_ends<R: Runtime, D: Clone + Send + Sync + 'static>(
    app: &AppHandle<R>,
    runner: &TauriUnitRunner<D>,
) {
    let bindings = Arc::clone(&runner.bindings);
    app.listen(
        BACKGROUND_SERVICE_EVENT,
        move |event| match serde_json::from_str::<BackgroundServicePluginEvent>(event.payload()) {
            Ok(plugin_event) => {
                if let Some(end) = PluginSessionEnd::from_plugin_event(&plugin_event) {
                    bindings.session_end_pairing.deliver(end);
                }
            }
            Err(error) => {
                log::warn!("[unit-runner] undecodable {BACKGROUND_SERVICE_EVENT} payload: {error}")
            }
        },
    );
}

impl<D: Clone + Send + Sync + 'static> TauriUnitRunner<D> {
    /// Follow the app's run events: start driving the background session once
    /// the app is ready, and follow window destruction, and moves to and from
    /// the background on a phone.
    ///
    /// The window events, not `RunEvent::Resumed`: tauri-runtime-wry raises
    /// that one on an event-loop poll, not when the app comes back.
    fn follow_run_event<R: Runtime>(&self, app: &AppHandle<R>, event: &RunEvent) {
        match event {
            RunEvent::Ready => {
                let platform = Arc::new(PluginBackgroundSession::new(
                    app.clone(),
                    self.bindings.start_config.clone(),
                ));
                self.unit_runner.start_driving_background_session(platform);
            }
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => self.record_window_event(|window_state| window_state.window_destroyed(label)),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            RunEvent::WindowEvent {
                event: WindowEvent::Suspended,
                ..
            } => self.record_window_event(WindowState::moved_to_background),
            #[cfg(any(target_os = "ios", target_os = "android"))]
            RunEvent::WindowEvent {
                event: WindowEvent::Resumed,
                ..
            } => self.record_window_event(WindowState::returned_to_foreground),
            _ => {}
        }
    }

    /// Record a window event with `record_on_window_state`, and pass what it
    /// means on to `UnitRunner`. Running units restart first, so units the
    /// change starts aren't restarted too.
    fn record_window_event(
        &self,
        record_on_window_state: impl FnOnce(&mut WindowState) -> WindowStateChange,
    ) {
        let change = {
            // Each event is one set insert or flag write, which no panic
            // leaves half-done.
            let mut window_state = self
                .bindings
                .window_state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            record_on_window_state(&mut window_state)
        };
        if change.unit_restarts_needed {
            self.unit_runner.restart_running_units();
        }
        self.unit_runner.set_app_present(change.present_after_event);
    }
}
