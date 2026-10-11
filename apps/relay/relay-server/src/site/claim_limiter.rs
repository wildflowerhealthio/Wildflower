//! [`ClaimLimiter`] — the rate limits on `POST /claim`, per client and
//! across all clients.
//!
//! A claim code is short enough to guess only if guessing is fast, so every
//! attempt, whatever it carries, spends from two allowances: the client's
//! own, keyed by its address, and one shared by every client. An attempt
//! either allowance refuses spends from neither.
//!
//! Each allowance is a [`Rate`]: a burst of attempts at once, refilled one
//! attempt per interval. The limits, [`PER_CLIENT`] and [`GLOBAL`], allow
//! about 3,600 guesses an hour across every client; against 31⁸ codes, a
//! live code survives an hour of that with odds better than 10⁸ to one.
//!
//! A client is a [`ClientKey`]: its IPv4 address, or its IPv6 address's
//! `/64`. The address is the TCP peer the front accepted, which no header
//! can change. At most [`MAX_CLIENTS`] clients are tracked; once the table
//! is full, clients whose allowance has refilled are dropped, and if none
//! has, new clients are refused until one does. The limiter itself is
//! `wildflowerhealthio_kitchen_sink`'s [`RateLimiter`].

use std::time::Duration;

use wildflowerhealthio_kitchen_sink::rate_limit::{ClientKey, Rate, RateLimiter};

/// The rate limits of `POST /claim`, by client.
pub(crate) type ClaimLimiter = RateLimiter<ClientKey>;

/// Each client's allowance: five attempts at once, then one every twelve
/// seconds (five a minute).
pub(crate) const PER_CLIENT: Rate = Rate {
    burst: 5,
    interval: Duration::from_secs(12),
};

/// The allowance every client shares: sixty attempts at once, then one a
/// second.
pub(crate) const GLOBAL: Rate = Rate {
    burst: 60,
    interval: Duration::from_secs(1),
};

/// The most clients tracked at once.
pub(crate) const MAX_CLIENTS: usize = 4_096;
