//! Project-agnostic utilities, standard library only.
//!
//! - [`loopback_port`] — a loopback port for a server under test to bind,
//!   picked below the ephemeral range so another process's `bind(0)` or
//!   outbound connection can't take it first.
//! - [`rate_limit`] — burst-and-refill rate limits (the generic cell rate
//!   algorithm): one [`Allowance`](rate_limit::Allowance), a bounded table
//!   of them by key, a thread-safe [`RateLimiter`](rate_limit::RateLimiter)
//!   that spends from a key's allowance and a shared one together, and the
//!   [`ClientKey`](rate_limit::ClientKey) a network client is limited by.
//! - `source_guard` — test-only, behind the `test-support` feature: every
//!   `.rs` file under a directory, sorted, and a path relative to a root, for
//!   tests that assert a textual invariant over a crate's source.

pub mod loopback_port;
pub mod rate_limit;
#[cfg(any(test, feature = "test-support"))]
pub mod source_guard;
