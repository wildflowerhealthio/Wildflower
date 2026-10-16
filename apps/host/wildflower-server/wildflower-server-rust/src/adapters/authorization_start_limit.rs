//! The authorization server's [`AuthorizationStartGate`] for the tunnel: how
//! fast visitors may start authorization requests, `GET /oauth/authorize` and
//! `POST /oauth/device_authorization`.
//!
//! Anyone who knows the server's domain can start a request, and each one
//! parks a request and raises the Owner's approval popup on the server's
//! device. Both routes cost the Owner that same popup, so the authorization
//! server's limit on them asks one [`AuthorizationStartLimit`] for every
//! request to either, and answers `429 Too Many Requests` when it refuses. It
//! asks before the request is parsed, so every attempt counts, however
//! malformed. A request from a browser signed in as the Owner (a live Owner
//! browser session) is never asked about, so it spends nothing.
//!
//! The limit is two allowances, each a [`Rate`]: a burst of attempts at once,
//! refilled one attempt per interval, [`PER_CLIENT`] for each visitor and
//! [`GLOBAL`] across all of them. A request either allowance refuses spends
//! from neither. Every other start shares them, a Pebble's
//! `POST /oauth/device_authorization` included: a flood from many addresses
//! can hold off a device's sign-in, never a signed-in Owner's launch.
//!
//! A visitor is keyed by the address its [`TunnelVisitor`] connect info
//! holds, as a [`ClientKey`]: its IPv4 address, or its IPv6 address's `/64`.
//! The TCP peer of every tunnel connection is the in-process tunnel, so that
//! address comes from the PROXY header the relay writes ahead of each
//! connection (see `tunnel_listener::proxy_header`), which the visitor can't
//! write. A tunnel connection with no address shares one allowance with every
//! other such connection. A request with no `TunnelVisitor` at all didn't come
//! through the tunnel listener, so it is local and admitted, spending nothing.
//! A `Forwarded` or `X-Forwarded-*` header is the visitor's own claim and is
//! never read; the tunnel front drops them before the routes anyway (see
//! `refuse_misdirected_requests`). At most [`MAX_CLIENTS`] visitors are
//! tracked; once the table is full, visitors whose allowance has refilled are
//! dropped, and if none has, new visitors are refused until one does. The
//! limiter itself is `wildflowerhealthio_kitchen_sink`'s [`RateLimiter`].

use std::time::{Duration, Instant};

use axum::extract::ConnectInfo;
use axum::http::Extensions;
use wildflowerhealthio_authorization_server::AuthorizationStartGate;
use wildflowerhealthio_kitchen_sink::rate_limit::{ClientKey, Rate, RateLimiter};

use crate::http::tunnel_listener::TunnelVisitor;

/// Each visitor's allowance: ten requests at once, then one every thirty
/// seconds (120 an hour). Enough for a person opening several apps at once,
/// or a developer reloading one, while one address can't flood the Owner with
/// popups.
pub(crate) const PER_CLIENT: Rate = Rate {
    burst: 10,
    interval: Duration::from_secs(30),
};

/// The allowance every visitor shares: thirty requests at once, then one
/// every ten seconds (360 an hour). The server has one Owner, so this caps
/// how fast popups reach them, however many addresses ask.
pub(crate) const GLOBAL: Rate = Rate {
    burst: 30,
    interval: Duration::from_secs(10),
};

/// The most visitors tracked at once.
pub(crate) const MAX_CLIENTS: usize = 1_024;

/// The limits on starting an authorization request through the tunnel, by
/// visitor: `None` for every visitor whose connection named no address.
pub(crate) struct AuthorizationStartLimit {
    limiter: RateLimiter<Option<ClientKey>>,
}

impl AuthorizationStartLimit {
    /// The limit with [`PER_CLIENT`] for each visitor, [`GLOBAL`] across all
    /// of them, and at most [`MAX_CLIENTS`] tracked.
    pub(crate) fn new() -> Self {
        Self::with_rates(PER_CLIENT, GLOBAL)
    }

    /// The limit with `per_client` for each visitor and `global` across all
    /// of them.
    fn with_rates(per_client: Rate, global: Rate) -> Self {
        Self {
            limiter: RateLimiter::new(per_client, global, MAX_CLIENTS),
        }
    }
}

impl AuthorizationStartGate for AuthorizationStartLimit {
    fn admit(&self, request_extensions: &Extensions) -> bool {
        let Some(ConnectInfo(tunnel_visitor)) =
            request_extensions.get::<ConnectInfo<TunnelVisitor>>()
        else {
            return true;
        };
        let admitted = self
            .limiter
            .admit(visitor_key(*tunnel_visitor), Instant::now());
        if !admitted {
            tracing::debug!(
                client_address = ?tunnel_visitor.client_address,
                "authorization request refused: rate limited"
            );
        }
        admitted
    }
}

/// The key `tunnel_visitor`'s allowance is kept under: its address's
/// [`ClientKey`], or `None` when its connection named no address.
fn visitor_key(tunnel_visitor: TunnelVisitor) -> Option<ClientKey> {
    tunnel_visitor
        .client_address
        .map(|client_address| ClientKey::from(client_address.ip()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small per-visitor allowance, so a test spends it in a few requests.
    const TEST_PER_CLIENT: Rate = Rate {
        burst: 2,
        interval: Duration::from_secs(3_600),
    };

    /// A shared allowance larger than one visitor's and smaller than three
    /// visitors'.
    const TEST_GLOBAL: Rate = Rate {
        burst: 5,
        interval: Duration::from_secs(3_600),
    };

    const ALICE: Option<&str> = Some("192.0.2.1:4711");
    const BOB: Option<&str> = Some("198.51.100.9:4711");
    const CAROL: Option<&str> = Some("[2001:db8::1]:4711");

    /// The extensions of a tunnel request from the visitor at
    /// `client_address`.
    fn from_visitor(client_address: Option<&str>) -> Extensions {
        let mut extensions = Extensions::new();
        extensions.insert(ConnectInfo(TunnelVisitor {
            client_address: client_address.map(|address| address.parse().expect("address")),
        }));
        extensions
    }

    /// Whether `limit` admits a request from the visitor at `client_address`.
    fn admits(limit: &AuthorizationStartLimit, client_address: Option<&str>) -> bool {
        limit.admit(&from_visitor(client_address))
    }

    #[test]
    fn a_visitor_over_its_burst_is_refused_and_another_still_gets_through() {
        let limit = AuthorizationStartLimit::with_rates(TEST_PER_CLIENT, TEST_GLOBAL);
        for _ in 0..TEST_PER_CLIENT.burst {
            assert!(admits(&limit, ALICE));
        }

        assert!(!admits(&limit, ALICE));
        assert!(admits(&limit, BOB));
    }

    #[test]
    fn once_the_shared_allowance_is_spent_every_visitor_is_refused() {
        let limit = AuthorizationStartLimit::with_rates(TEST_PER_CLIENT, TEST_GLOBAL);
        let mut admitted = 0;
        for client_address in [ALICE, BOB, CAROL] {
            for _ in 0..TEST_PER_CLIENT.burst {
                if admits(&limit, client_address) {
                    admitted += 1;
                }
            }
        }
        assert_eq!(admitted, TEST_GLOBAL.burst);

        for client_address in [Some("203.0.113.7:4711"), None] {
            assert!(!admits(&limit, client_address), "{client_address:?}");
        }
    }

    #[test]
    fn visitors_with_no_address_share_one_allowance() {
        let limit = AuthorizationStartLimit::with_rates(TEST_PER_CLIENT, TEST_GLOBAL);
        for _ in 0..TEST_PER_CLIENT.burst {
            assert!(admits(&limit, None));
        }

        assert!(!admits(&limit, None));
        assert!(admits(&limit, ALICE));
    }

    #[test]
    fn a_request_not_through_the_tunnel_is_admitted_and_spends_nothing() {
        let limit = AuthorizationStartLimit::with_rates(TEST_PER_CLIENT, TEST_GLOBAL);
        for _ in 0..TEST_GLOBAL.burst * 2 {
            assert!(limit.admit(&Extensions::new()));
        }

        for _ in 0..TEST_PER_CLIENT.burst {
            assert!(admits(&limit, ALICE));
        }
    }
}
