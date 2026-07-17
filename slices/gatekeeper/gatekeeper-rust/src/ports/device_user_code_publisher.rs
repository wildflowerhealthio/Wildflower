//! [`DeviceUserCodePublisher`] — the seam a device-code consent action calls to
//! republish the active popup head after it changes the pending queue.

/// Republish the head of the pending device-code consent queue over the bridge.
///
/// A device-flow approve or deny may resolve (or advance) the head the host
/// webview surfaces in its non-dismissable popup, so the action calls this after
/// the store write to close/advance the modal. The real implementation
/// ([`GatekeeperState`](crate::http::GatekeeperState)) recomputes the head from the store and
/// publishes it through the bridge watch channel; a test fake just records that
/// it was asked to.
pub(crate) trait DeviceUserCodePublisher: Send + Sync + 'static {
    /// Recompute and republish the active device-code consent head.
    fn republish_active(&self);
}
