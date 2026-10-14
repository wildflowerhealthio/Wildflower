//! The layers around the composed API: the [`cors`] policy, the
//! [`loopback_owner_trust`] that presents the owner bearer for a direct-local
//! caller on the loopback listener, the [`forwarded_request_layer`] that
//! reports each forwarded request to the host, the [`tunnel_front`] that
//! writes each tunnel request's `Forwarded` header, and the
//! [`session_cookie_bearer`] that presents the bearer the Owner's or the FHIR
//! web UI's session cookie stands for.

pub(crate) mod cors;
pub(crate) mod forwarded_request_layer;
pub(crate) mod loopback_owner_trust;
pub(crate) mod session_cookie_bearer;
pub(crate) mod tunnel_front;
