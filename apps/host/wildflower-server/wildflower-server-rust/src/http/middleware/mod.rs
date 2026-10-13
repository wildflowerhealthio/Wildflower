//! The layers around the composed API: the [`cors`] policy, the
//! [`loopback_owner_trust`] that presents the owner bearer for a direct-local
//! caller on the loopback listener, the [`forwarded_request_layer`] that
//! reports each forwarded request to the host, the [`tunnel_front`] that
//! writes each tunnel request's `Forwarded` header, and the
//! [`ui_session_bearer`] that presents a FHIR web UI session's bearer.

pub(crate) mod cors;
pub(crate) mod forwarded_request_layer;
pub(crate) mod loopback_owner_trust;
pub(crate) mod tunnel_front;
pub(crate) mod ui_session_bearer;
