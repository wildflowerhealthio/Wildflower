//! Project-agnostic utilities, standard library only.
//!
//! - [`rate_limit`] — burst-and-refill rate limits (the generic cell rate
//!   algorithm): one [`Allowance`](rate_limit::Allowance), a bounded table
//!   of them by key, a thread-safe [`RateLimiter`](rate_limit::RateLimiter)
//!   that spends from a key's allowance and a shared one together, and the
//!   [`ClientKey`](rate_limit::ClientKey) a network client is limited by.

pub mod rate_limit;
