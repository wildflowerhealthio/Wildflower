# kitchen-sink-rust

Project-agnostic Rust utilities, standard library only: the native
counterpart of [`kitchen-sink`](../kitchen-sink). The crate is
`wildflowerhealthio-kitchen-sink`. Nothing here knows about Wildflower, FHIR
or any slice, so each module can be copied into an unrelated project.

## Modules

- `rate_limit` — burst-and-refill rate limits by the generic cell rate
  algorithm.
  - `Rate { burst, interval }`: a burst of attempts at once, refilled one
    attempt per interval.
  - `Allowance`: one budget under a `Rate`, kept as the single instant it is
    booked until. `after_attempt` returns the allowance after one attempt,
    or `None` when none is left; `admit` spends in place.
  - `KeyedAllowances<K>`: an `Allowance` per key for at most a fixed number
    of keys. A full table drops the keys whose allowances have refilled, and
    refuses new keys if none has.
  - `RateLimiter<K>`: a `KeyedAllowances<K>` and one allowance every key
    shares, behind a lock. `admit(key, now)` spends from both, or, refused
    by either, from neither.
  - `ClientKey`: a network client as it is limited, `From<IpAddr>`: its IPv4
    address, or its IPv6 address's `/64`, with IPv4-mapped IPv6 addresses
    taken as IPv4.

## Usage

```rust
use std::net::IpAddr;
use std::time::{Duration, Instant};

use wildflowerhealthio_kitchen_sink::rate_limit::{ClientKey, Rate, RateLimiter};

let per_client = Rate { burst: 5, interval: Duration::from_secs(12) };
let shared = Rate { burst: 60, interval: Duration::from_secs(1) };
let limiter: RateLimiter<ClientKey> = RateLimiter::new(per_client, shared, 4_096);

let peer: IpAddr = "203.0.113.7".parse().unwrap();
if !limiter.admit(ClientKey::from(peer), Instant::now()) {
    // Answer 429.
}
```
