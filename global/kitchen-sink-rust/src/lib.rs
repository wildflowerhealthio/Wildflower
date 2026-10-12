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

pub mod loopback_port;
pub mod rate_limit;
