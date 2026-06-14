//! Per-IP throttle for the device-flow consent surface (`/access/devices/...`),
//! whose handlers look up a pending request by its short, human-typeable
//! `user_code`. The small code space makes that lookup brute-forceable, so this
//! limiter caps how many attempts one remote client may make in a window and
//! answers a `429 Too Many Requests` (with `Retry-After`) past it.
//!
//! The limiter is an in-memory sliding window keyed by the *real* client IP. The
//! gatekeeper sits behind a loopback gate, so the `ConnectInfo` peer is
//! `127.0.0.1` for every tunnel-forwarded request and can't distinguish
//! clients; when the tunnel forwards the original client address in
//! `x-forwarded-for` we key on that instead, falling back to `ConnectInfo` for
//! direct loopback hits. See [`rate_limit_key`].

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use parking_lot::Mutex;

/// How many `user_code` lookup attempts one client IP may make per
/// [`USER_CODE_RATE_LIMIT_WINDOW`] before being throttled. Generous enough for a
/// human typing a pairing code, tight against brute-forcing the short code
/// space.
pub const USER_CODE_RATE_LIMIT_ATTEMPTS: usize = 10;

/// The sliding window over which [`USER_CODE_RATE_LIMIT_ATTEMPTS`] is counted.
pub const USER_CODE_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);

/// Above this many tracked keys, a `check` opportunistically drops keys whose
/// windows have fully drained. Bounds memory against a churn of one-shot IPs
/// without paying an O(n) sweep on every call.
const PRUNE_THRESHOLD: usize = 1024;

/// Build the limiter the device-consent path is wired with — the
/// [`USER_CODE_RATE_LIMIT_ATTEMPTS`]/[`USER_CODE_RATE_LIMIT_WINDOW`] policy.
/// Centralised here so the constants and the construction stay together.
pub fn user_code_rate_limiter() -> SlidingWindowRateLimiter {
    SlidingWindowRateLimiter::new(USER_CODE_RATE_LIMIT_ATTEMPTS, USER_CODE_RATE_LIMIT_WINDOW)
}

/// An in-memory, per-key sliding-window rate limiter. Cheap to `clone` (shares
/// one `Arc<Mutex<..>>`), so it can live in [`AppState`](crate::http::AppState)
/// and be handed to a middleware layer. Only *admitted* attempts count toward
/// the budget, so a throttled client can't push its own window forward by
/// hammering the endpoint.
#[derive(Clone)]
pub struct SlidingWindowRateLimiter {
    inner: Arc<Mutex<HashMap<IpAddr, VecDeque<Instant>>>>,
    max_attempts: usize,
    window: Duration,
}

/// The outcome of a [`SlidingWindowRateLimiter::check`].
#[derive(Debug, PartialEq, Eq)]
pub enum RateLimitDecision {
    /// Under budget — the attempt was admitted and counted.
    Allowed,
    /// Over budget — not counted; retry once the window frees by `retry_after`.
    Limited { retry_after: Duration },
}

impl SlidingWindowRateLimiter {
    /// A limiter admitting `max_attempts` per `window` per key.
    pub fn new(max_attempts: usize, window: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            max_attempts,
            window,
        }
    }

    /// Record an attempt for `key` and report whether it is admitted. Wraps
    /// [`check_at`](Self::check_at) at the current instant.
    pub fn check(&self, key: IpAddr) -> RateLimitDecision {
        self.check_at(key, Instant::now())
    }

    /// [`check`](Self::check) at an explicit `now` — the sliding-window logic,
    /// with the clock injected so tests are deterministic.
    fn check_at(&self, key: IpAddr, now: Instant) -> RateLimitDecision {
        let mut map = self.inner.lock();
        if map.len() > PRUNE_THRESHOLD {
            map.retain(|_, attempts| {
                drop_expired(attempts, now, self.window);
                !attempts.is_empty()
            });
        }
        let attempts = map.entry(key).or_default();
        drop_expired(attempts, now, self.window);
        if attempts.len() >= self.max_attempts {
            // At capacity: the oldest in-window attempt sets when a slot frees.
            let oldest = *attempts
                .front()
                .expect("a full window has at least one attempt");
            let retry_after = self.window.saturating_sub(now.duration_since(oldest));
            RateLimitDecision::Limited { retry_after }
        } else {
            attempts.push_back(now);
            RateLimitDecision::Allowed
        }
    }
}

/// Pop attempts older than `window` off the front of `attempts`. The deque is
/// append-only at the back with monotonically non-decreasing instants, so every
/// expired attempt is a contiguous prefix.
fn drop_expired(attempts: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while let Some(&front) = attempts.front() {
        if now.duration_since(front) >= window {
            attempts.pop_front();
        } else {
            break;
        }
    }
}

/// The IP that keys the limiter for `req`. Prefers the left-most address of an
/// `x-forwarded-for` header — the original client when the tunnel forwards a
/// request — and falls back to the `ConnectInfo` peer for direct loopback hits.
/// If neither is present (unreachable behind the loopback gate, which fails
/// closed without `ConnectInfo`), every such request shares one bucket via the
/// unspecified address, which throttles conservatively rather than not at all.
fn rate_limit_key(req: &Request<Body>) -> IpAddr {
    if let Some(ip) = forwarded_client_ip(req.headers()) {
        return ip;
    }
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

/// The original client IP from `x-forwarded-for`: its left-most entry (RFC 7239
/// orders the list client-first). `None` when the header is absent or its first
/// entry isn't a parseable IP.
fn forwarded_client_ip(headers: &HeaderMap) -> Option<IpAddr> {
    let value = headers.get("x-forwarded-for")?.to_str().ok()?;
    value.split(',').next()?.trim().parse::<IpAddr>().ok()
}

/// Middleware that throttles the device-consent `user_code`-lookup path by
/// client IP. Admitted requests pass through; over-budget ones short-circuit
/// with a `429 Too Many Requests` carrying a `Retry-After` (delta-seconds).
pub async fn rate_limit_user_code(
    State(limiter): State<SlidingWindowRateLimiter>,
    req: Request<Body>,
    next: Next,
) -> Response {
    match limiter.check(rate_limit_key(&req)) {
        RateLimitDecision::Allowed => next.run(req).await,
        RateLimitDecision::Limited { retry_after } => {
            // Round up to a whole second, never below 1, so a sub-second
            // remainder doesn't render `Retry-After: 0` (i.e. "retry now").
            let secs = retry_after.as_secs().max(1);
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, secs.to_string())],
                "rate limit exceeded",
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn admits_up_to_the_budget_then_limits() {
        let limiter = SlidingWindowRateLimiter::new(3, Duration::from_secs(60));
        let now = Instant::now();
        let key = ip("203.0.113.7");
        for _ in 0..3 {
            assert_eq!(limiter.check_at(key, now), RateLimitDecision::Allowed);
        }
        let RateLimitDecision::Limited { retry_after } = limiter.check_at(key, now) else {
            panic!("4th attempt in the window must be limited");
        };
        // The first attempt is `window` from freeing a slot.
        assert_eq!(retry_after, Duration::from_secs(60));
    }

    #[test]
    fn keys_are_independent() {
        let limiter = SlidingWindowRateLimiter::new(1, Duration::from_secs(60));
        let now = Instant::now();
        assert_eq!(
            limiter.check_at(ip("203.0.113.1"), now),
            RateLimitDecision::Allowed
        );
        // A different IP has its own budget — not throttled by the first.
        assert_eq!(
            limiter.check_at(ip("203.0.113.2"), now),
            RateLimitDecision::Allowed
        );
    }

    #[test]
    fn window_slides_so_attempts_recover() {
        let limiter = SlidingWindowRateLimiter::new(1, Duration::from_secs(60));
        let start = Instant::now();
        let key = ip("203.0.113.9");
        assert_eq!(limiter.check_at(key, start), RateLimitDecision::Allowed);
        assert!(matches!(
            limiter.check_at(key, start + Duration::from_secs(30)),
            RateLimitDecision::Limited { .. }
        ));
        // Once the first attempt ages past the window, a slot frees.
        assert_eq!(
            limiter.check_at(key, start + Duration::from_secs(60)),
            RateLimitDecision::Allowed
        );
    }

    #[test]
    fn over_limit_attempts_do_not_extend_the_window() {
        // Only admitted attempts are recorded, so hammering while throttled
        // can't push the window forward and starve recovery.
        let limiter = SlidingWindowRateLimiter::new(1, Duration::from_secs(60));
        let start = Instant::now();
        let key = ip("203.0.113.10");
        assert_eq!(limiter.check_at(key, start), RateLimitDecision::Allowed);
        // A flurry of rejected attempts mid-window.
        for offset in [10, 20, 30, 40] {
            assert!(matches!(
                limiter.check_at(key, start + Duration::from_secs(offset)),
                RateLimitDecision::Limited { .. }
            ));
        }
        // The slot still frees a full window after the single *admitted* attempt.
        assert_eq!(
            limiter.check_at(key, start + Duration::from_secs(60)),
            RateLimitDecision::Allowed
        );
    }

    #[test]
    fn forwarded_client_ip_prefers_left_most_entry() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "203.0.113.5, 70.41.3.18, 127.0.0.1".parse().unwrap(),
        );
        assert_eq!(forwarded_client_ip(&headers), Some(ip("203.0.113.5")));
    }

    #[test]
    fn forwarded_client_ip_absent_or_unparseable_is_none() {
        assert_eq!(forwarded_client_ip(&HeaderMap::new()), None);
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "not-an-ip".parse().unwrap());
        assert_eq!(forwarded_client_ip(&headers), None);
    }
}
