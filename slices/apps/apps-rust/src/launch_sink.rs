//! The on-device launch side-effect seam.
//!
//! The platform-pure launch handler resolves the served origin and the
//! redirect target the same way for every host. What it does with that target
//! differs: a browser/standalone host wants a `302` to follow, but the Tauri
//! host wants to open the URL in a native webview popup while leaving the SPA
//! mounted. [`OnDeviceLaunchSink`] is the host seam for that second case — when
//! one is installed, the handler hands it the resolved `(app, url)` instead of
//! returning a redirect.
//!
//! ## Loopback-only by construction
//!
//! A host-side popup only helps the **local** caller — opening one for a
//! *remote* (relayed/forwarded) request would pop a window on the host device
//! for someone who can't see it. That invariant used to live only in a match
//! arm in the launch handler. It's now enforced by the type system:
//! [`OnDeviceLaunchSink::open`] demands a [`LoopbackCaller`] witness, and the
//! only way to mint one is [`LoopbackCaller::from_provenance`] on a
//! [`RequestProvenance::Loopback`]. A future call site physically can't open
//! the sink for a forwarded caller.

use shared_structures_rust::served_origin::RequestProvenance;

use crate::domain::AppEntry;

/// A zero-size witness that the launch request came from a loopback caller.
///
/// The inner `()` is private, so the only constructor is
/// [`Self::from_provenance`] — which yields `Some` only for
/// [`RequestProvenance::Loopback`]. Holding one is proof the caller is local,
/// which is the precondition [`OnDeviceLaunchSink::open`] requires.
#[derive(Debug, Clone, Copy)]
pub struct LoopbackCaller(());

impl LoopbackCaller {
    /// Mint a witness from a request's provenance: `Some` only when the caller
    /// is loopback, `None` for a forwarded (remote) caller.
    #[must_use]
    pub fn from_provenance(provenance: &RequestProvenance) -> Option<Self> {
        match provenance {
            RequestProvenance::Loopback => Some(Self(())),
            RequestProvenance::Forwarded { .. } => None,
        }
    }
}

/// Host seam for the on-device launch side-effect. The platform-pure handler
/// resolves the URL, then hands it (with its app) to the host's sink instead of
/// returning a redirect. Fire-and-forget: the handler 204s and the host logs
/// any failure (mirrors the SPA's prior fire-and-forget bridge emit).
///
/// `open` requires a [`LoopbackCaller`] witness, so it can only be invoked for
/// a local caller — the host popup can't be opened for a remote/forwarded one.
pub trait OnDeviceLaunchSink: Send + Sync {
    fn open(&self, caller: LoopbackCaller, app: &AppEntry, url: &str);
}
