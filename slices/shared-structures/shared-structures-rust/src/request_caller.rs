//! Who made a request the server answered, as the layer that authenticated or
//! routed it knows it, and the record the server reports for each forwarded
//! request: each one that came in through the tunnel.
//!
//! The authorization server bearer gates stamp a [`RequestCaller`] on a response's
//! extensions, from the verified token, or a [`RequestRefusal`] on the `401`
//! they answer instead. The server's forwarded-request layer reads them back
//! and reports a [`ForwardedRequest`] to the host, which turns them into
//! notifications. The types live here so the gates and the layer meet without
//! depending on each other.

use std::time::{Duration, SystemTime};

/// The OAuth client a response was served to: an authorization server bearer gate
/// verified the request's token, which is bound to this client (the token's
/// `sub`). Stamped on the response's extensions, so it is its own type rather
/// than a bare `String`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RequestCaller {
    pub client_id: String,
}

/// Why an authorization server bearer gate answered `401`: stamped on the response's
/// extensions in place of a [`RequestCaller`].
///
/// A `403` that carries a [`RequestCaller`] is the other refusal a caller can
/// get: the gate verified the token, and the route's scope check then found it
/// too narrow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RequestRefusal {
    /// The request carried no `Authorization: Bearer` token.
    MissingToken,
    /// The token failed signature or claim validation.
    TokenRejected,
    /// The token verified but has been revoked.
    Revoked,
}

/// One forwarded request, through the tunnel, reported after its response is
/// ready.
///
/// It holds no record identifiers: the path is reduced to its route before it
/// gets here, and the query string is dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardedRequest {
    /// When the request reached the server.
    pub received_at: SystemTime,
    /// The visitor's IP address, from the tunnel connection's PROXY header.
    /// `None` when the connection had no header or the header named no
    /// address.
    pub client_address: Option<String>,
    /// The server's public `host[:port]`, which every request is served at.
    /// `Some` on every record the server reports.
    pub served_host: Option<String>,
    /// The request method, e.g. `GET`.
    pub method: String,
    /// The request path reduced to its route, its first segment (`/authorization`,
    /// or a FHIR resource type such as `/Patient`).
    pub reduced_path: String,
    /// The response status code.
    pub status: u16,
    /// The response body's length, when the body knows it up front.
    pub response_bytes: Option<u64>,
    /// How long the server took to produce the response.
    pub duration: Duration,
    /// The caller stamped on the response, or `None` when no bearer gate
    /// verified one (an ungated route or a refused token).
    pub caller: Option<RequestCaller>,
    /// Why a bearer gate refused the request, or `None` when none did.
    pub refusal: Option<RequestRefusal>,
}
