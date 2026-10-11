//! [`ClaimLimiter`] — the rate limits on `POST /claim`, per client and
//! across all clients.
//!
//! A claim code is short enough to guess only if guessing is fast, so every
//! attempt, whatever it carries, spends from two allowances: the client's
//! own, keyed by its address, and one shared by every client. An attempt
//! either allowance refuses spends from neither.
//!
//! Each allowance is a [`Rate`]: a burst of attempts at once, refilled one
//! attempt per interval (the generic cell rate algorithm, which keeps one
//! instant per allowance). The defaults, [`PER_CLIENT`] and [`GLOBAL`], allow
//! about 3,600 guesses an hour across every client; against 31⁸ codes, a
//! live code survives an hour of that with odds better than 10⁸ to one.
//!
//! A client is its IPv4 address, or its IPv6 address's `/64`, the smallest
//! block a host is usually given. The address is the TCP peer the front
//! accepted, which no header can change. At most [`MAX_CLIENTS`] clients are
//! tracked; once the table is full, clients whose allowance has refilled are
//! dropped, and if none has, new clients are refused until one does.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// A burst of attempts, refilled one attempt every `interval`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rate {
    pub(crate) burst: u32,
    pub(crate) interval: Duration,
}

impl Rate {
    /// How far ahead of now an allowance may be booked: a full burst.
    fn window(self) -> Duration {
        self.interval * self.burst
    }
}

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

/// A client, as its allowance is keyed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Client {
    V4(std::net::Ipv4Addr),
    /// The first 64 bits of an IPv6 address.
    V6Prefix(u64),
}

impl From<IpAddr> for Client {
    fn from(addr: IpAddr) -> Self {
        match addr.to_canonical() {
            IpAddr::V4(v4) => Client::V4(v4),
            IpAddr::V6(v6) => Client::V6Prefix(prefix_64(v6)),
        }
    }
}

/// The first 64 bits of `addr`.
fn prefix_64(addr: Ipv6Addr) -> u64 {
    let [a, b, c, d, ..] = addr.segments();
    (u64::from(a) << 48) | (u64::from(b) << 32) | (u64::from(c) << 16) | u64::from(d)
}

/// The rate limits of `POST /claim`.
#[derive(Debug)]
pub(crate) struct ClaimLimiter {
    per_client: Rate,
    global: Rate,
    max_clients: usize,
    allowances: Mutex<Allowances>,
}

/// When each allowance is booked until: an attempt at `now` is allowed if
/// booking one more interval keeps it within a burst of `now`.
#[derive(Debug, Default)]
struct Allowances {
    global: Option<Instant>,
    clients: HashMap<Client, Instant>,
}

impl ClaimLimiter {
    /// Limits of `per_client` for each client and `global` across them,
    /// tracking at most `max_clients` clients.
    pub(crate) fn new(per_client: Rate, global: Rate, max_clients: usize) -> Self {
        Self {
            per_client,
            global,
            max_clients,
            allowances: Mutex::new(Allowances::default()),
        }
    }

    /// Whether the client at `addr` may make an attempt at `now`, spending
    /// from its allowance and the global one if so.
    pub(crate) fn admit(&self, addr: IpAddr, now: Instant) -> bool {
        let client = Client::from(addr);
        let mut allowances = self
            .allowances
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !allowances.clients.contains_key(&client) && allowances.clients.len() >= self.max_clients
        {
            allowances.clients.retain(|_, booked| *booked > now);
            if allowances.clients.len() >= self.max_clients {
                return false;
            }
        }
        let client_booked = allowances.clients.get(&client).copied();
        let (Some(client_next), Some(global_next)) = (
            book(client_booked, now, self.per_client),
            book(allowances.global, now, self.global),
        ) else {
            return false;
        };
        allowances.clients.insert(client, client_next);
        allowances.global = Some(global_next);
        true
    }
}

/// The allowance booked until `booked`, after one more attempt at `now`
/// under `rate`; `None` if that would book it beyond a burst ahead of `now`.
fn book(booked: Option<Instant>, now: Instant, rate: Rate) -> Option<Instant> {
    let next = booked.map_or(now, |booked| booked.max(now)) + rate.interval;
    (next <= now + rate.window()).then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 7));
    const BOB: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(198, 51, 100, 9));

    /// How many of `attempts` at `now` from `addr` are admitted.
    fn admitted(limiter: &ClaimLimiter, addr: IpAddr, now: Instant, attempts: u32) -> u32 {
        (0..attempts)
            .map(|_| u32::from(limiter.admit(addr, now)))
            .sum()
    }

    #[test]
    fn a_client_gets_its_burst_then_one_attempt_per_interval() {
        let limiter = ClaimLimiter::new(PER_CLIENT, GLOBAL, MAX_CLIENTS);
        let start = Instant::now();
        assert_eq!(admitted(&limiter, ALICE, start, 20), PER_CLIENT.burst);
        assert_eq!(
            admitted(&limiter, BOB, start, 1),
            1,
            "another client has its own allowance"
        );
        let later = start + PER_CLIENT.interval;
        assert_eq!(admitted(&limiter, ALICE, later, 20), 1);
        let refilled = later + PER_CLIENT.window();
        assert_eq!(admitted(&limiter, ALICE, refilled, 20), PER_CLIENT.burst);
    }

    #[test]
    fn every_client_together_trips_the_global_limit() {
        let limiter = ClaimLimiter::new(PER_CLIENT, GLOBAL, MAX_CLIENTS);
        let now = Instant::now();
        let clients = (0..=255u8).map(|last| IpAddr::from([192, 0, 2, last]));
        let total: u32 = clients.map(|addr| admitted(&limiter, addr, now, 1)).sum();
        assert_eq!(total, GLOBAL.burst);
        let later = now + GLOBAL.interval;
        assert_eq!(
            admitted(&limiter, IpAddr::from([198, 18, 0, 1]), later, 5),
            1
        );
    }

    /// An attempt one allowance refuses spends from neither.
    #[test]
    fn a_refused_attempt_spends_nothing() {
        let limiter = ClaimLimiter::new(
            Rate {
                burst: 1,
                interval: Duration::from_secs(10),
            },
            Rate {
                burst: 2,
                interval: Duration::from_secs(10),
            },
            MAX_CLIENTS,
        );
        let now = Instant::now();
        assert!(limiter.admit(ALICE, now));
        for _ in 0..5 {
            assert!(!limiter.admit(ALICE, now), "alice is over her own limit");
        }
        assert!(
            limiter.admit(BOB, now),
            "alice's refusals left bob the rest"
        );
    }

    #[test]
    fn an_ipv6_client_is_its_64_and_a_mapped_ipv4_its_address() {
        let limiter = ClaimLimiter::new(PER_CLIENT, GLOBAL, MAX_CLIENTS);
        let now = Instant::now();
        let hosts = (1..=20u16).map(|host| IpAddr::from([0x2001, 0xdb8, 0, 1, 0, 0, 0, host]));
        let total: u32 = hosts.map(|addr| admitted(&limiter, addr, now, 1)).sum();
        assert_eq!(total, PER_CLIENT.burst, "one /64 is one client");
        let other_64 = IpAddr::from([0x2001, 0xdb8, 0, 2, 0, 0, 0, 1]);
        assert_eq!(admitted(&limiter, other_64, now, 1), 1);

        let mapped: IpAddr = "::ffff:203.0.113.7".parse().unwrap();
        assert_eq!(
            admitted(&limiter, mapped, now, 20) + admitted(&limiter, ALICE, now, 20),
            PER_CLIENT.burst
        );
    }

    #[test]
    fn a_full_table_drops_refilled_clients_and_otherwise_refuses_new_ones() {
        let limiter = ClaimLimiter::new(PER_CLIENT, GLOBAL, 2);
        let now = Instant::now();
        assert!(limiter.admit(ALICE, now));
        assert!(limiter.admit(BOB, now));
        let carol = IpAddr::from([192, 0, 2, 3]);
        assert!(!limiter.admit(carol, now), "no room, and nobody refilled");
        assert!(limiter.admit(ALICE, now), "a tracked client still gets in");

        let refilled = now + PER_CLIENT.window();
        assert!(limiter.admit(carol, refilled));
    }
}
