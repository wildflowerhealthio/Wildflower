//! What a user dismissal does to an instance — [`DismissalAction`], chosen per
//! open on [`OpenRequest::on_dismiss`]. The native backends always **hide** on a
//! dismissal (see docs/Lifecycle and Races Explanation.md § "User dismissal
//! hides; only `dispose` tears down"); an instance opened with
//! [`DismissalAction::Dispose`] is then disposed from here, in Rust, so no
//! backend (desktop, Swift, Kotlin) needs to know the setting.
//!
//! Every backend emits the same [`NativeWebviewEvent::Hidden`] for a user
//! dismissal and for a host `hide()`. A `Dispose` instance's event channel is
//! therefore wrapped ([`event_channel_for`]): it forwards every event to the
//! caller's channel and disposes on a `Hidden` no host `hide()` caused. The
//! backends' `hide` marks a host hide of such an instance in flight
//! ([`DisposingOnDismissal::begin_host_hide`]) before hiding, and the wrapper
//! consumes the mark at that hide's `Hidden`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};

use crate::models::{NativeWebviewEvent, OpenRequest};
use crate::NativeWebviewExt;

/// What a user dismissal (chrome Close, back, sheet swipe, desktop titlebar X)
/// does to an instance.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DismissalAction {
    /// Hide it, keeping it alive and running; a later `open_url`/`show` reuses
    /// it. The default.
    #[default]
    Hide,
    /// Hide it, then dispose it: the instance is torn down and emits
    /// [`NativeWebviewEvent::Disposed`] after its `Hidden`. A host `hide()`
    /// still only hides.
    Dispose,
}

/// The instances whose latest open chose [`DismissalAction::Dispose`], each
/// keyed by id to whether a host `hide()` of it is in flight (so its `Hidden`
/// is not a user dismissal). Managed plugin state on every platform; cheap to
/// clone (the map is shared).
#[derive(Clone, Default)]
pub(crate) struct DisposingOnDismissal(Arc<Mutex<HashMap<String, bool>>>);

impl DisposingOnDismissal {
    /// Record the dismissal action of the open of `id` now starting: a
    /// `Dispose` open tracks `id` with no host hide in flight, a `Hide` open
    /// forgets it.
    fn record_open(&self, id: &str, on_dismiss: DismissalAction) {
        let mut instances = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match on_dismiss {
            DismissalAction::Dispose => {
                instances.insert(id.to_owned(), false);
            }
            DismissalAction::Hide => {
                instances.remove(id);
            }
        }
    }

    /// Mark a host `hide()` of `id` in flight, when `id` disposes on dismissal,
    /// so the `Hidden` it causes doesn't dispose it. A backend calls this
    /// before hiding, and [`DisposingOnDismissal::cancel_host_hide`] when the
    /// hide caused no `Hidden`.
    pub(crate) fn begin_host_hide(&self, id: &str) {
        let mut instances = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(host_hide_in_flight) = instances.get_mut(id) {
            *host_hide_in_flight = true;
        }
    }

    /// Clear `id`'s host-hide mark: the hide found nothing visible, or failed,
    /// so no `Hidden` will consume it.
    pub(crate) fn cancel_host_hide(&self, id: &str) {
        let mut instances = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(host_hide_in_flight) = instances.get_mut(id) {
            *host_hide_in_flight = false;
        }
    }

    /// Whether a `Hidden` on `id` is a user dismissal to dispose on: `id`
    /// disposes on dismissal and no host hide is in flight. Consumes a host
    /// hide's mark, which its one `Hidden` answers.
    fn take_is_user_dismissal(&self, id: &str) -> bool {
        let mut instances = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        instances
            .get_mut(id)
            .is_some_and(|host_hide_in_flight| !std::mem::take(host_hide_in_flight))
    }
}

/// The event channel the backend gets for the open of `id`: the caller's own
/// channel for a [`DismissalAction::Hide`] open, or for a `Dispose` open a
/// channel that forwards every event to it and disposes `id` on a user
/// dismissal. Records the open's action either way.
pub(crate) fn event_channel_for<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    request: &OpenRequest,
) -> Channel<NativeWebviewEvent> {
    let disposing_on_dismissal = app.state::<DisposingOnDismissal>().inner().clone();
    disposing_on_dismissal.record_open(id, request.on_dismiss);
    match request.on_dismiss {
        DismissalAction::Hide => request.native_webview_event_channel.clone(),
        DismissalAction::Dispose => {
            let app = app.clone();
            disposing_channel(
                disposing_on_dismissal,
                id,
                request.native_webview_event_channel.clone(),
                move |id| dispose_off_the_event_path(&app, id),
            )
        }
    }
}

/// Dispose `id` on a blocking thread. The `Hidden` arrives inside a backend's
/// event path (on desktop the window's `CloseRequested` handler, holding the
/// instance's channel lock), so the dispose runs after it returns rather than
/// re-entering it.
fn dispose_off_the_event_path<R: Runtime>(app: &AppHandle<R>, id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = app.native_webview().dispose(&id) {
            log::error!("[native-webview] dispose of dismissed {id} failed: {error}");
        }
    });
}

/// A channel forwarding every event to `caller_channel` and calling `dispose`
/// with `id` after forwarding a `Hidden` that is a user dismissal.
fn disposing_channel(
    disposing_on_dismissal: DisposingOnDismissal,
    id: &str,
    caller_channel: Channel<NativeWebviewEvent>,
    dispose: impl Fn(String) + Send + Sync + 'static,
) -> Channel<NativeWebviewEvent> {
    let id = id.to_owned();
    Channel::new(move |body| {
        let event: NativeWebviewEvent = body.deserialize()?;
        let is_user_dismissal = event == NativeWebviewEvent::Hidden
            && disposing_on_dismissal.take_is_user_dismissal(&id);
        caller_channel.send(event)?;
        if is_user_dismissal {
            dispose(id.clone());
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A channel recording the events it receives.
    fn recording_channel() -> (
        Channel<NativeWebviewEvent>,
        Arc<Mutex<Vec<NativeWebviewEvent>>>,
    ) {
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink = received.clone();
        let channel = Channel::new(move |body| {
            sink.lock().unwrap().push(body.deserialize()?);
            Ok(())
        });
        (channel, received)
    }

    /// A `Dispose` instance's channel, the events its caller received, and the
    /// ids it disposed.
    struct DisposeOpen {
        channel: Channel<NativeWebviewEvent>,
        received: Arc<Mutex<Vec<NativeWebviewEvent>>>,
        disposed: Arc<Mutex<Vec<String>>>,
    }

    fn dispose_open(disposing_on_dismissal: &DisposingOnDismissal, id: &str) -> DisposeOpen {
        disposing_on_dismissal.record_open(id, DismissalAction::Dispose);
        let (caller_channel, received) = recording_channel();
        let disposed = Arc::new(Mutex::new(Vec::new()));
        let disposed_sink = disposed.clone();
        let channel = disposing_channel(
            disposing_on_dismissal.clone(),
            id,
            caller_channel,
            move |id| disposed_sink.lock().unwrap().push(id),
        );
        DisposeOpen {
            channel,
            received,
            disposed,
        }
    }

    /// Every event reaches the caller, and a user dismissal's `Hidden` disposes
    /// the instance after it is forwarded.
    #[test]
    fn a_user_dismissal_disposes_after_forwarding_every_event() {
        let disposing_on_dismissal = DisposingOnDismissal::default();
        let DisposeOpen {
            channel,
            received,
            disposed,
        } = dispose_open(&disposing_on_dismissal, "launcher-a");
        let message = NativeWebviewEvent::Message {
            payload: "hi".to_owned(),
        };
        channel.send(message.clone()).unwrap();
        assert!(disposed.lock().unwrap().is_empty());

        channel.send(NativeWebviewEvent::Hidden).unwrap();
        channel.send(NativeWebviewEvent::Disposed).unwrap();
        assert_eq!(
            *received.lock().unwrap(),
            vec![
                message,
                NativeWebviewEvent::Hidden,
                NativeWebviewEvent::Disposed
            ]
        );
        assert_eq!(*disposed.lock().unwrap(), vec!["launcher-a".to_owned()]);
    }

    /// A host `hide()`'s `Hidden` only hides; the next user dismissal disposes.
    #[test]
    fn a_host_hide_does_not_dispose() {
        let disposing_on_dismissal = DisposingOnDismissal::default();
        let DisposeOpen {
            channel,
            received,
            disposed,
        } = dispose_open(&disposing_on_dismissal, "launcher-a");
        disposing_on_dismissal.begin_host_hide("launcher-a");
        channel.send(NativeWebviewEvent::Hidden).unwrap();
        assert!(disposed.lock().unwrap().is_empty());
        assert_eq!(*received.lock().unwrap(), vec![NativeWebviewEvent::Hidden]);

        channel.send(NativeWebviewEvent::Hidden).unwrap();
        assert_eq!(*disposed.lock().unwrap(), vec!["launcher-a".to_owned()]);
    }

    /// A host hide that caused no `Hidden` leaves no mark behind, so the next
    /// user dismissal still disposes.
    #[test]
    fn a_cancelled_host_hide_leaves_no_mark() {
        let disposing_on_dismissal = DisposingOnDismissal::default();
        let DisposeOpen {
            channel, disposed, ..
        } = dispose_open(&disposing_on_dismissal, "launcher-a");
        disposing_on_dismissal.begin_host_hide("launcher-a");
        disposing_on_dismissal.cancel_host_hide("launcher-a");
        channel.send(NativeWebviewEvent::Hidden).unwrap();
        assert_eq!(*disposed.lock().unwrap(), vec!["launcher-a".to_owned()]);
    }

    /// A later `Hide` open of the same id forgets it, so a `Hidden` on a
    /// lingering `Dispose` channel no longer disposes.
    #[test]
    fn a_hide_open_forgets_the_instance() {
        let disposing_on_dismissal = DisposingOnDismissal::default();
        let DisposeOpen {
            channel, disposed, ..
        } = dispose_open(&disposing_on_dismissal, "launcher-a");
        disposing_on_dismissal.record_open("launcher-a", DismissalAction::Hide);
        channel.send(NativeWebviewEvent::Hidden).unwrap();
        assert!(disposed.lock().unwrap().is_empty());
    }

    /// Instances are tracked by id: one's host hide doesn't shield another.
    #[test]
    fn host_hides_are_per_instance() {
        let disposing_on_dismissal = DisposingOnDismissal::default();
        let disposed_a = dispose_open(&disposing_on_dismissal, "launcher-a").disposed;
        let DisposeOpen {
            channel: channel_b,
            disposed: disposed_b,
            ..
        } = dispose_open(&disposing_on_dismissal, "launcher-b");
        disposing_on_dismissal.begin_host_hide("launcher-a");
        channel_b.send(NativeWebviewEvent::Hidden).unwrap();
        assert!(disposed_a.lock().unwrap().is_empty());
        assert_eq!(*disposed_b.lock().unwrap(), vec!["launcher-b".to_owned()]);
    }
}
