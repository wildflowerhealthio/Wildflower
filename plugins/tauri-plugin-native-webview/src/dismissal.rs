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
//! backends' `hide` runs through [`DisposingOnDismissal::host_hide`], which
//! marks a host hide of such an instance in flight before hiding; the wrapper
//! consumes the mark at that hide's `Hidden`.
//!
//! The dispose is queued off the event path, so an open of the same instance
//! can land before it runs. Each open of an instance counts, and the queued
//! dispose goes ahead only while no open has come since the dismissal; once it
//! starts, an open waits for the backend's `dispose` to return, by which time
//! the backend defers it into its own dispose→open replay (see
//! docs/Lifecycle and Races Explanation.md § "The dispose→open \"switch-demo\"
//! race").

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

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

/// An instance whose latest open chose [`DismissalAction::Dispose`].
#[derive(Debug, Default)]
struct DisposingInstance {
    /// Whether a host `hide()` of it is in flight, so its `Hidden` is not a
    /// user dismissal.
    host_hide_in_flight: bool,
    /// How many opens of it there have been, so a dispose queued by a
    /// dismissal can tell whether an open came since.
    opens: u64,
}

/// The `Dispose` instances, by id, and the ids whose queued dispose is
/// calling the backend now.
#[derive(Debug, Default)]
struct Instances {
    disposing: HashMap<String, DisposingInstance>,
    dispose_starting: HashSet<String>,
}

/// The instances whose latest open chose [`DismissalAction::Dispose`], with
/// the disposes their dismissals queued. Managed plugin state on every
/// platform; cheap to clone (the state is shared).
#[derive(Clone, Default)]
pub(crate) struct DisposingOnDismissal(Arc<Shared>);

/// What every clone of a [`DisposingOnDismissal`] shares: the instances, and
/// the signal an open waiting on a starting dispose wakes on.
#[derive(Default)]
struct Shared {
    instances: Mutex<Instances>,
    /// Notified when a queued dispose's call to the backend returns.
    dispose_finished: Condvar,
}

/// The open of an instance a user dismissal disposes: the count of its opens
/// when it was dismissed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DismissedOpen(u64);

impl DisposingOnDismissal {
    fn lock(&self) -> MutexGuard<'_, Instances> {
        self.0
            .instances
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Record the dismissal action of the open of `id` now starting: a
    /// `Dispose` open tracks `id` with no host hide in flight, a `Hide` open
    /// forgets it. Either way it counts as an open since any dismissal, so a
    /// dispose that dismissal queued doesn't run. While such a dispose is
    /// calling the backend, it waits for that call to return.
    fn record_open(&self, id: &str, on_dismiss: DismissalAction) {
        let mut instances = self
            .0
            .dispose_finished
            .wait_while(self.lock(), |instances| {
                instances.dispose_starting.contains(id)
            })
            .unwrap_or_else(PoisonError::into_inner);
        match on_dismiss {
            DismissalAction::Dispose => {
                let instance = instances.disposing.entry(id.to_owned()).or_default();
                instance.host_hide_in_flight = false;
                instance.opens += 1;
            }
            DismissalAction::Hide => {
                instances.disposing.remove(id);
            }
        }
    }

    /// Hide `id` as the host asked, through the backend's `hide`, which
    /// answers whether it caused a `Hidden` (sent, or still to come). A
    /// `Dispose` instance is marked as hiding first, so the `Hidden` it
    /// causes doesn't dispose it; a hide that causes none, or fails, clears
    /// the mark, since no `Hidden` will consume it.
    ///
    /// # Errors
    ///
    /// `hide`'s.
    pub(crate) fn host_hide<E>(
        &self,
        id: &str,
        hide: impl FnOnce() -> Result<bool, E>,
    ) -> Result<(), E> {
        self.set_host_hide_in_flight(id, true);
        let caused_hidden = hide();
        if !matches!(caused_hidden, Ok(true)) {
            self.set_host_hide_in_flight(id, false);
        }
        caused_hidden.map(|_| ())
    }

    fn set_host_hide_in_flight(&self, id: &str, in_flight: bool) {
        if let Some(instance) = self.lock().disposing.get_mut(id) {
            instance.host_hide_in_flight = in_flight;
        }
    }

    /// The open a `Hidden` on `id` dismissed, when it is a user dismissal to
    /// dispose on: `id` disposes on dismissal and no host hide is in flight.
    /// Consumes a host hide's mark, which its one `Hidden` answers.
    fn take_user_dismissal(&self, id: &str) -> Option<DismissedOpen> {
        let mut instances = self.lock();
        let instance = instances.disposing.get_mut(id)?;
        let host_hide = std::mem::take(&mut instance.host_hide_in_flight);
        (!host_hide).then_some(DismissedOpen(instance.opens))
    }

    /// Run the dispose a user dismissal of `dismissed` queued for `id`,
    /// through the backend's `dispose`, unless an open of `id` came since:
    /// that open owns the instance now. Opens wait while `dispose` runs.
    fn dispose_unless_reopened(
        &self,
        id: &str,
        dismissed: DismissedOpen,
        dispose: impl FnOnce(&str),
    ) {
        {
            let mut instances = self.lock();
            let reopened = instances
                .disposing
                .get(id)
                .is_none_or(|instance| DismissedOpen(instance.opens) != dismissed);
            if reopened {
                return;
            }
            instances.dispose_starting.insert(id.to_owned());
        }
        dispose(id);
        self.lock().dispose_starting.remove(id);
        self.0.dispose_finished.notify_all();
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
            let queued = disposing_on_dismissal.clone();
            disposing_channel(
                disposing_on_dismissal,
                id,
                request.native_webview_event_channel.clone(),
                move |id, dismissed| {
                    dispose_off_the_event_path(&app, queued.clone(), id, dismissed)
                },
            )
        }
    }
}

/// Dispose `id` on a blocking thread, unless an open of it comes first (see
/// [`DisposingOnDismissal::dispose_unless_reopened`]). The `Hidden` arrives
/// inside a backend's event path (on desktop the window's `CloseRequested`
/// handler, holding the instance's channel lock), so the dispose runs after it
/// returns rather than re-entering it.
fn dispose_off_the_event_path<R: Runtime>(
    app: &AppHandle<R>,
    disposing_on_dismissal: DisposingOnDismissal,
    id: String,
    dismissed: DismissedOpen,
) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        disposing_on_dismissal.dispose_unless_reopened(&id, dismissed, |id| {
            if let Err(error) = app.native_webview().dispose(id) {
                log::error!("[native-webview] dispose of dismissed {id} failed: {error}");
            }
        });
    });
}

/// A channel forwarding every event to `caller_channel` and calling `dispose`
/// with `id` and the open it dismissed after forwarding a `Hidden` that is a
/// user dismissal.
fn disposing_channel(
    disposing_on_dismissal: DisposingOnDismissal,
    id: &str,
    caller_channel: Channel<NativeWebviewEvent>,
    dispose: impl Fn(String, DismissedOpen) + Send + Sync + 'static,
) -> Channel<NativeWebviewEvent> {
    let id = id.to_owned();
    Channel::new(move |body| {
        let event: NativeWebviewEvent = body.deserialize()?;
        let user_dismissal = if event == NativeWebviewEvent::Hidden {
            disposing_on_dismissal.take_user_dismissal(&id)
        } else {
            None
        };
        caller_channel.send(event)?;
        if let Some(dismissed) = user_dismissal {
            dispose(id.clone(), dismissed);
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

    /// A `Dispose` instance's channel, the events its caller received, the
    /// disposes its dismissals queued, and the ids those disposed once run.
    struct DisposeOpen {
        disposing_on_dismissal: DisposingOnDismissal,
        channel: Channel<NativeWebviewEvent>,
        received: Arc<Mutex<Vec<NativeWebviewEvent>>>,
        queued: Arc<Mutex<Vec<(String, DismissedOpen)>>>,
        disposed: Arc<Mutex<Vec<String>>>,
    }

    impl DisposeOpen {
        /// Run every queued dispose, as the blocking thread would.
        fn run_queued_disposes(&self) {
            let queued = std::mem::take(&mut *self.queued.lock().unwrap());
            for (id, dismissed) in queued {
                self.disposing_on_dismissal
                    .dispose_unless_reopened(&id, dismissed, |id| {
                        self.disposed.lock().unwrap().push(id.to_owned());
                    });
            }
        }

        /// A user dismissal: the backend hides and sends `Hidden`, and the
        /// dispose it queues runs.
        fn dismiss(&self) {
            self.channel.send(NativeWebviewEvent::Hidden).unwrap();
            self.run_queued_disposes();
        }
    }

    fn dispose_open(disposing_on_dismissal: &DisposingOnDismissal, id: &str) -> DisposeOpen {
        disposing_on_dismissal.record_open(id, DismissalAction::Dispose);
        let (caller_channel, received) = recording_channel();
        let queued = Arc::new(Mutex::new(Vec::new()));
        let queued_sink = queued.clone();
        let channel = disposing_channel(
            disposing_on_dismissal.clone(),
            id,
            caller_channel,
            move |id, dismissed| queued_sink.lock().unwrap().push((id, dismissed)),
        );
        DisposeOpen {
            disposing_on_dismissal: disposing_on_dismissal.clone(),
            channel,
            received,
            queued,
            disposed: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// A host hide whose `hide` sends `Hidden` on `channel` before answering,
    /// as desktop's and Android's do.
    fn host_hide_sending_hidden(
        disposing_on_dismissal: &DisposingOnDismissal,
        id: &str,
        channel: &Channel<NativeWebviewEvent>,
    ) {
        disposing_on_dismissal
            .host_hide(id, || {
                channel.send(NativeWebviewEvent::Hidden).unwrap();
                Ok::<_, ()>(true)
            })
            .unwrap();
    }

    /// Every event reaches the caller, and a user dismissal's `Hidden` disposes
    /// the instance after it is forwarded.
    #[test]
    fn a_user_dismissal_disposes_after_forwarding_every_event() {
        let open = dispose_open(&DisposingOnDismissal::default(), "launcher-a");
        let message = NativeWebviewEvent::Message {
            payload: "hi".to_owned(),
        };
        open.channel.send(message.clone()).unwrap();
        open.run_queued_disposes();
        assert!(open.disposed.lock().unwrap().is_empty());

        open.dismiss();
        open.channel.send(NativeWebviewEvent::Disposed).unwrap();
        assert_eq!(
            *open.received.lock().unwrap(),
            vec![
                message,
                NativeWebviewEvent::Hidden,
                NativeWebviewEvent::Disposed
            ]
        );
        assert_eq!(
            *open.disposed.lock().unwrap(),
            vec!["launcher-a".to_owned()]
        );
    }

    /// A host `hide()` whose `Hidden` arrives before it answers (desktop,
    /// Android) only hides; the next user dismissal disposes.
    #[test]
    fn a_host_hide_does_not_dispose() {
        let open = dispose_open(&DisposingOnDismissal::default(), "launcher-a");
        host_hide_sending_hidden(&open.disposing_on_dismissal, "launcher-a", &open.channel);
        open.run_queued_disposes();
        assert!(open.disposed.lock().unwrap().is_empty());
        assert_eq!(
            *open.received.lock().unwrap(),
            vec![NativeWebviewEvent::Hidden]
        );

        open.dismiss();
        assert_eq!(
            *open.disposed.lock().unwrap(),
            vec!["launcher-a".to_owned()]
        );
    }

    /// A host hide whose `Hidden` comes after it answers (iOS's dismiss
    /// animation) only hides too.
    #[test]
    fn a_host_hide_s_later_hidden_does_not_dispose() {
        let open = dispose_open(&DisposingOnDismissal::default(), "launcher-a");
        open.disposing_on_dismissal
            .host_hide("launcher-a", || Ok::<_, ()>(true))
            .unwrap();
        open.dismiss();
        assert!(open.disposed.lock().unwrap().is_empty());
    }

    /// A host hide that caused no `Hidden` (`requestCausedHide: false`), or
    /// failed, leaves no mark behind, so the next user dismissal still
    /// disposes.
    #[test]
    fn a_host_hide_that_caused_no_hidden_leaves_no_mark() {
        let open = dispose_open(&DisposingOnDismissal::default(), "launcher-a");
        open.disposing_on_dismissal
            .host_hide("launcher-a", || Ok::<_, ()>(false))
            .unwrap();
        open.dismiss();
        assert_eq!(
            *open.disposed.lock().unwrap(),
            vec!["launcher-a".to_owned()]
        );

        let open = dispose_open(&DisposingOnDismissal::default(), "launcher-b");
        assert_eq!(
            open.disposing_on_dismissal
                .host_hide("launcher-b", || Err::<bool, _>("no window")),
            Err("no window")
        );
        open.dismiss();
        assert_eq!(
            *open.disposed.lock().unwrap(),
            vec!["launcher-b".to_owned()]
        );
    }

    /// A later `Hide` open of the same id forgets it, so a `Hidden` on a
    /// lingering `Dispose` channel no longer disposes.
    #[test]
    fn a_hide_open_forgets_the_instance() {
        let open = dispose_open(&DisposingOnDismissal::default(), "launcher-a");
        open.disposing_on_dismissal
            .record_open("launcher-a", DismissalAction::Hide);
        open.dismiss();
        assert!(open.disposed.lock().unwrap().is_empty());
    }

    /// An open that lands after a dismissal but before the dispose it queued
    /// runs owns the instance: the dispose doesn't run, so what the open shows
    /// stays open. A later dismissal of that open disposes it.
    #[test]
    fn an_open_before_the_queued_dispose_runs_keeps_the_instance() {
        let disposing_on_dismissal = DisposingOnDismissal::default();
        let first = dispose_open(&disposing_on_dismissal, "launcher-a");
        first.channel.send(NativeWebviewEvent::Hidden).unwrap();
        assert_eq!(first.queued.lock().unwrap().len(), 1);

        for on_dismiss in [DismissalAction::Dispose, DismissalAction::Hide] {
            let open = dispose_open(&DisposingOnDismissal::default(), "launcher-b");
            open.channel.send(NativeWebviewEvent::Hidden).unwrap();
            open.disposing_on_dismissal
                .record_open("launcher-b", on_dismiss);
            open.run_queued_disposes();
            assert!(open.disposed.lock().unwrap().is_empty(), "{on_dismiss:?}");
        }

        let second = dispose_open(&disposing_on_dismissal, "launcher-a");
        first.run_queued_disposes();
        assert!(first.disposed.lock().unwrap().is_empty());

        second.dismiss();
        assert_eq!(
            *second.disposed.lock().unwrap(),
            vec!["launcher-a".to_owned()]
        );
    }

    /// An open that lands while the queued dispose is calling the backend
    /// waits for that call to return, so the backend sees it as an open after
    /// a dispose, which it defers into its own replay.
    #[test]
    fn an_open_during_the_queued_dispose_waits_for_it() {
        let open = dispose_open(&DisposingOnDismissal::default(), "launcher-a");
        open.channel.send(NativeWebviewEvent::Hidden).unwrap();
        let (id, dismissed) = open.queued.lock().unwrap().pop().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut opener = None;

        open.disposing_on_dismissal
            .dispose_unless_reopened(&id, dismissed, |_| {
                let disposing_on_dismissal = open.disposing_on_dismissal.clone();
                let open_events = events.clone();
                opener = Some(std::thread::spawn(move || {
                    disposing_on_dismissal.record_open("launcher-a", DismissalAction::Dispose);
                    open_events.lock().unwrap().push("opened");
                }));
                std::thread::sleep(std::time::Duration::from_millis(50));
                events.lock().unwrap().push("disposed");
            });

        opener.unwrap().join().unwrap();
        assert_eq!(*events.lock().unwrap(), vec!["disposed", "opened"]);
    }

    /// Instances are tracked by id: one's host hide doesn't shield another.
    #[test]
    fn host_hides_are_per_instance() {
        let disposing_on_dismissal = DisposingOnDismissal::default();
        let a = dispose_open(&disposing_on_dismissal, "launcher-a");
        let b = dispose_open(&disposing_on_dismissal, "launcher-b");
        disposing_on_dismissal.set_host_hide_in_flight("launcher-a", true);
        b.dismiss();
        assert!(a.disposed.lock().unwrap().is_empty());
        assert_eq!(*b.disposed.lock().unwrap(), vec!["launcher-b".to_owned()]);
    }
}
