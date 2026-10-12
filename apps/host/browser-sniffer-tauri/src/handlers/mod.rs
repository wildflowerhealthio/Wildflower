//! One file per web→host control event the crate listens to.
//! Each handler decodes its payload, resolves whatever it needs, and
//! dispatches to the sniffer-window layer; failures log and the listener
//! loop continues to the next event.

pub(crate) mod open;
pub(crate) mod sniffing_complete;
