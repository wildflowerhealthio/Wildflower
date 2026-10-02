//! The layers around the composed API: the [`cors`] policy, the
//! [`loopback_owner_trust`] that presents the owner bearer for a direct-local
//! caller, and the outermost [`forwarded_request_layer`] that reports each
//! forwarded request to the host.

pub(crate) mod cors;
pub(crate) mod forwarded_request_layer;
pub(crate) mod loopback_owner_trust;
