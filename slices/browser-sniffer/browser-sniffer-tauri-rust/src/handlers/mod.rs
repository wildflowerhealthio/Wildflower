//! One file per CollectorBridge.webToHost event the crate listens to.
//! Each handler decodes its payload, resolves whatever it needs, and
//! dispatches to the sniffer-window layer; failures log and the listener
//! loop continues to the next event.

pub(crate) mod open;
pub(crate) mod request_sniffable_webview;
pub(crate) mod sniffing_complete;
