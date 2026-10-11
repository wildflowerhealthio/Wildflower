//! Burst-and-refill rate limits, by the generic cell rate algorithm (GCRA).
//!
//! A [`Rate`] allows a burst of attempts at once, refilled one attempt per
//! interval. An [`Allowance`] is one such budget, kept as a single instant:
//! how far ahead of now it is booked. An attempt books one more interval,
//! and is refused, booking nothing, if that would book it more than a full
//! burst ahead.
//!
//! [`KeyedAllowances`] holds one allowance per key, for at most a fixed
//! number of keys. Once the table is full, keys whose allowance has refilled
//! are dropped, which loses nothing since an untracked key starts full; if
//! none has, new keys are refused until one does. [`RateLimiter`] pairs that
//! table with one allowance every key shares, behind a lock: an attempt
//! spends from both or, refused by either, from neither.
//!
//! [`ClientKey`] is the usual key for a network client: its IPv4 address, or
//! its IPv6 address's `/64`, the smallest block a host is usually given.

use std::collections::HashMap;
use std::hash::Hash;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// A burst of attempts, refilled one attempt every `interval`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rate {
    pub burst: u32,
    pub interval: Duration,
}

impl Rate {
    /// How long an emptied allowance takes to refill: a full burst of
    /// intervals, and how far ahead of now one may be booked.
    #[must_use]
    pub fn window(self) -> Duration {
        self.interval * self.burst
    }
}

/// One allowance under a [`Rate`]: the instant it is booked until, or none
/// when it has never been spent. A new allowance is full.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Allowance {
    booked_until: Option<Instant>,
}

impl Allowance {
    /// This allowance after one attempt at `now` under `rate`; `None` when
    /// it has no attempt left at `now`.
    #[must_use]
    pub fn after_attempt(self, rate: Rate, now: Instant) -> Option<Allowance> {
        let booked_until = self.booked_until.map_or(now, |booked| booked.max(now)) + rate.interval;
        (booked_until <= now + rate.window()).then_some(Allowance {
            booked_until: Some(booked_until),
        })
    }

    /// Whether an attempt at `now` is allowed under `rate`, spending from
    /// this allowance if so.
    pub fn admit(&mut self, rate: Rate, now: Instant) -> bool {
        match self.after_attempt(rate, now) {
            Some(spent) => {
                *self = spent;
                true
            }
            None => false,
        }
    }

    /// Whether the allowance is full again at `now`, as if never spent.
    #[must_use]
    pub fn is_full(self, now: Instant) -> bool {
        self.booked_until.is_none_or(|booked| booked <= now)
    }
}

/// An [`Allowance`] for each of at most `max_keys` keys.
#[derive(Debug)]
pub struct KeyedAllowances<K> {
    max_keys: usize,
    by_key: HashMap<K, Allowance>,
}

impl<K: Hash + Eq> KeyedAllowances<K> {
    /// An empty table that tracks at most `max_keys` keys.
    #[must_use]
    pub fn new(max_keys: usize) -> Self {
        Self {
            max_keys,
            by_key: HashMap::new(),
        }
    }

    /// Whether `key` may make an attempt at `now` under `rate`, spending
    /// from its allowance if so. A new key is refused, and not tracked, when
    /// the table is full of keys whose allowances are still refilling.
    pub fn admit(&mut self, key: K, rate: Rate, now: Instant) -> bool {
        let Some(spent) = self
            .allowance_with_room(&key, now)
            .and_then(|allowance| allowance.after_attempt(rate, now))
        else {
            return false;
        };
        self.set(key, spent);
        true
    }

    /// Track `key` as having `allowance`. Called only once
    /// [`allowance_with_room`](Self::allowance_with_room) found it room.
    fn set(&mut self, key: K, allowance: Allowance) {
        self.by_key.insert(key, allowance);
    }

    /// `key`'s allowance, full when it is not tracked, once the table has
    /// room for it: a full table first drops the keys whose allowances are
    /// full at `now`. `None` when it still has no room.
    fn allowance_with_room(&mut self, key: &K, now: Instant) -> Option<Allowance> {
        if let Some(tracked) = self.by_key.get(key) {
            return Some(*tracked);
        }
        if self.by_key.len() >= self.max_keys {
            self.by_key.retain(|_, allowance| !allowance.is_full(now));
        }
        (self.by_key.len() < self.max_keys).then(Allowance::default)
    }
}

/// Limits attempts by key, each key under its own allowance, and across
/// every key under one shared allowance. Safe to share between threads.
#[derive(Debug)]
pub struct RateLimiter<K> {
    per_key: Rate,
    shared: Rate,
    allowances: Mutex<RateLimiterAllowances<K>>,
}

/// What a [`RateLimiter`] keeps behind its lock.
#[derive(Debug)]
struct RateLimiterAllowances<K> {
    keyed: KeyedAllowances<K>,
    shared: Allowance,
}

impl<K: Hash + Eq> RateLimiter<K> {
    /// A limit of `per_key` for each key and `shared` across every key,
    /// tracking at most `max_keys` keys (see [`KeyedAllowances`]).
    #[must_use]
    pub fn new(per_key: Rate, shared: Rate, max_keys: usize) -> Self {
        Self {
            per_key,
            shared,
            allowances: Mutex::new(RateLimiterAllowances {
                keyed: KeyedAllowances::new(max_keys),
                shared: Allowance::default(),
            }),
        }
    }

    /// Whether `key` may make an attempt at `now`, spending from its
    /// allowance and the shared one if so. An attempt either refuses spends
    /// from neither.
    pub fn admit(&self, key: K, now: Instant) -> bool {
        let mut allowances = self
            .allowances
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(key_allowance) = allowances.keyed.allowance_with_room(&key, now) else {
            return false;
        };
        let (Some(key_spent), Some(shared_spent)) = (
            key_allowance.after_attempt(self.per_key, now),
            allowances.shared.after_attempt(self.shared, now),
        ) else {
            return false;
        };
        allowances.keyed.set(key, key_spent);
        allowances.shared = shared_spent;
        true
    }
}

/// A network client, as its allowance is keyed: an IPv4 address, or the
/// `/64` of an IPv6 address. An IPv4-mapped IPv6 address is its IPv4
/// address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClientKey {
    V4(Ipv4Addr),
    /// The first 64 bits of an IPv6 address.
    V6Prefix(u64),
}

impl From<IpAddr> for ClientKey {
    fn from(addr: IpAddr) -> Self {
        match addr.to_canonical() {
            IpAddr::V4(v4) => ClientKey::V4(v4),
            IpAddr::V6(v6) => ClientKey::V6Prefix(prefix_64(v6)),
        }
    }
}

/// The first 64 bits of `addr`.
fn prefix_64(addr: Ipv6Addr) -> u64 {
    let [a, b, c, d, ..] = addr.segments();
    (u64::from(a) << 48) | (u64::from(b) << 32) | (u64::from(c) << 16) | u64::from(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PER_KEY: Rate = Rate {
        burst: 5,
        interval: Duration::from_secs(12),
    };
    const SHARED: Rate = Rate {
        burst: 60,
        interval: Duration::from_secs(1),
    };
    const MAX_KEYS: usize = 4_096;

    const ALICE: IpAddr = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7));
    const BOB: IpAddr = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 9));

    fn limiter(max_keys: usize) -> RateLimiter<ClientKey> {
        RateLimiter::new(PER_KEY, SHARED, max_keys)
    }

    /// How many of `attempts` at `now` from `addr` are admitted.
    fn admitted(
        limiter: &RateLimiter<ClientKey>,
        addr: IpAddr,
        now: Instant,
        attempts: u32,
    ) -> u32 {
        (0..attempts)
            .map(|_| u32::from(limiter.admit(ClientKey::from(addr), now)))
            .sum()
    }

    #[test]
    fn an_allowance_gives_its_burst_then_one_attempt_per_interval() {
        let start = Instant::now();
        let mut allowance = Allowance::default();
        assert!(allowance.is_full(start));
        let burst = (0..20).filter(|_| allowance.admit(PER_KEY, start)).count();
        assert_eq!(burst, 5);
        assert!(!allowance.is_full(start));

        let later = start + PER_KEY.interval;
        assert!(allowance.admit(PER_KEY, later));
        assert!(!allowance.admit(PER_KEY, later));
        assert!(allowance.is_full(later + PER_KEY.window()));
    }

    #[test]
    fn a_key_gets_its_burst_then_one_attempt_per_interval() {
        let limiter = limiter(MAX_KEYS);
        let start = Instant::now();
        assert_eq!(admitted(&limiter, ALICE, start, 20), PER_KEY.burst);
        assert_eq!(
            admitted(&limiter, BOB, start, 1),
            1,
            "another key has its own allowance"
        );
        let later = start + PER_KEY.interval;
        assert_eq!(admitted(&limiter, ALICE, later, 20), 1);
        let refilled = later + PER_KEY.window();
        assert_eq!(admitted(&limiter, ALICE, refilled, 20), PER_KEY.burst);
    }

    #[test]
    fn every_key_together_trips_the_shared_limit() {
        let limiter = limiter(MAX_KEYS);
        let now = Instant::now();
        let clients = (0..=255u8).map(|last| IpAddr::from([192, 0, 2, last]));
        let total: u32 = clients.map(|addr| admitted(&limiter, addr, now, 1)).sum();
        assert_eq!(total, SHARED.burst);
        let later = now + SHARED.interval;
        assert_eq!(
            admitted(&limiter, IpAddr::from([198, 18, 0, 1]), later, 5),
            1
        );
    }

    /// An attempt one allowance refuses spends from neither.
    #[test]
    fn a_refused_attempt_spends_nothing() {
        let limiter = RateLimiter::new(
            Rate {
                burst: 1,
                interval: Duration::from_secs(10),
            },
            Rate {
                burst: 2,
                interval: Duration::from_secs(10),
            },
            MAX_KEYS,
        );
        let now = Instant::now();
        assert!(limiter.admit("alice", now));
        for _ in 0..5 {
            assert!(!limiter.admit("alice", now), "alice is over her own limit");
        }
        assert!(
            limiter.admit("bob", now),
            "alice's refusals left bob the rest"
        );
    }

    #[test]
    fn an_ipv6_client_is_its_64_and_a_mapped_ipv4_its_address() {
        let limiter = limiter(MAX_KEYS);
        let now = Instant::now();
        let hosts = (1..=20u16).map(|host| IpAddr::from([0x2001, 0xdb8, 0, 1, 0, 0, 0, host]));
        let total: u32 = hosts.map(|addr| admitted(&limiter, addr, now, 1)).sum();
        assert_eq!(total, PER_KEY.burst, "one /64 is one client");
        let other_64 = IpAddr::from([0x2001, 0xdb8, 0, 2, 0, 0, 0, 1]);
        assert_eq!(admitted(&limiter, other_64, now, 1), 1);

        let mapped: IpAddr = "::ffff:203.0.113.7".parse().unwrap();
        assert_eq!(ClientKey::from(mapped), ClientKey::from(ALICE));
        assert_eq!(
            admitted(&limiter, mapped, now, 20) + admitted(&limiter, ALICE, now, 20),
            PER_KEY.burst
        );
    }

    #[test]
    fn a_full_table_drops_refilled_keys_and_otherwise_refuses_new_ones() {
        let limiter = limiter(2);
        let now = Instant::now();
        assert!(limiter.admit(ClientKey::from(ALICE), now));
        assert!(limiter.admit(ClientKey::from(BOB), now));
        let carol = ClientKey::from(IpAddr::from([192, 0, 2, 3]));
        assert!(!limiter.admit(carol, now), "no room, and nobody refilled");
        assert!(
            limiter.admit(ClientKey::from(ALICE), now),
            "a tracked key still gets in"
        );

        let refilled = now + PER_KEY.window();
        assert!(limiter.admit(carol, refilled));
    }

    /// The table on its own, without a shared allowance, keeps the same
    /// bound.
    #[test]
    fn keyed_allowances_alone_keep_the_bound() {
        let mut table = KeyedAllowances::new(1);
        let now = Instant::now();
        assert!(table.admit("alice", PER_KEY, now));
        assert!(!table.admit("bob", PER_KEY, now), "no room");
        assert!(table.admit("bob", PER_KEY, now + PER_KEY.window()));
    }
}
