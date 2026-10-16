//! The layers around the composed API: the [`cors`] policy, the
//! [`forwarded_request_layer`] that reports each forwarded request to the request log, the [`tunnel_front`] that
//! holds each tunnel request to the server's domain, the
//! [`authorization_start_limit`] on how fast visitors start authorization
//! requests, and the [`session_cookie_bearer`] that presents the bearer the
//! Owner's or the FHIR web UI's session cookie stands for.

pub(crate) mod authorization_start_limit;
pub(crate) mod cors;
pub(crate) mod forwarded_request_layer;
pub(crate) mod session_cookie_bearer;
pub(crate) mod tunnel_front;
