//! The layers around the composed API: the [`cors`] policy, the
//! [`loopback_owner_trust`] that presents the owner bearer for a direct-local
//! caller, the [`forwarded_request_layer`] that reports each forwarded request
//! to the host, and outermost the [`tunnel_provenance`] that writes a tunnel
//! request's `Forwarded` header.

pub(crate) mod cors;
pub(crate) mod forwarded_request_layer;
pub(crate) mod loopback_owner_trust;
pub(crate) mod tunnel_provenance;
