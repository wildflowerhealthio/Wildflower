//! Who made a request the server answered, as the layer that authenticated or
//! routed it knows it, and the observation the server reports for each request
//! that came in through the tunnel.
//!
//! Two producers stamp a [`RequestCaller`] on a response's extensions: the
//! gatekeeper bearer gates (an OAuth client, from the verified token) and the
//! tunnel's subdomain reverse proxy (the self-hosted app it forwarded to). The
//! server's forwarded-request layer reads it back and reports a
//! [`ForwardedRequest`] to the host, which turns them into notifications. The
//! types live here so the producers and the consumer meet without depending on
//! each other.

/// The caller a response was served to, stamped on the response's extensions
/// by the layer that knows it.
///
/// A response carries at most one: the bearer gates and the reverse proxy are
/// alternatives (the proxy answers a self-hosted app's subdomain *instead of*
/// the gated API), so no request passes both.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RequestCaller {
    /// A gatekeeper bearer gate verified the request's token, which is bound to
    /// this OAuth client (the token's `sub`).
    OAuthClient { client_id: String },
    /// The tunnel's subdomain reverse proxy forwarded the request to this
    /// self-hosted app's loopback listener.
    SelfHostedApp { app_id: String },
}

/// One request the trusted front relayed through the tunnel, reported after
/// its response is ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardedRequest {
    /// The caller stamped on the response, or `None` when no layer identified
    /// one (an ungated route, a rejected token, an unmatched subdomain).
    pub caller: Option<RequestCaller>,
}
