//! Who made a request the server answered, as the layer that authenticated or
//! routed it knows it, and the observation the server reports for each request
//! that came in through the tunnel.
//!
//! The gatekeeper bearer gates stamp a [`RequestCaller`] on a response's
//! extensions, from the verified token. The server's forwarded-request layer
//! reads it back and reports a [`ForwardedRequest`] to the host, which turns
//! them into notifications. The types live here so the gates and the layer meet
//! without depending on each other.

/// The OAuth client a response was served to: a gatekeeper bearer gate
/// verified the request's token, which is bound to this client (the token's
/// `sub`). Stamped on the response's extensions, so it is its own type rather
/// than a bare `String`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RequestCaller {
    pub client_id: String,
}

/// One request the trusted front relayed through the tunnel, reported after
/// its response is ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardedRequest {
    /// The caller stamped on the response, or `None` when no bearer gate
    /// verified one (an ungated route or a rejected token).
    pub caller: Option<RequestCaller>,
}
