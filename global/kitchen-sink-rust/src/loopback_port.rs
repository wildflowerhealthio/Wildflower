//! A loopback port for a test to hand to a server that binds by address.
//!
//! Binding port 0 and dropping the listener finds a port that was free, but
//! not one that stays free until the server binds it. The kernel hands the
//! same ephemeral range out to every other `bind(0)` and as the local port of
//! every outbound connection, so under a parallel test run another process
//! often takes the port first. The server then fails to listen, and its
//! clients dial whatever holds the port.
//!
//! [`free_loopback_port`] picks below the ephemeral range instead, where the
//! kernel never assigns a port on its own (Linux starts that range at 32768,
//! macOS and Windows at 49152), and checks the port is free at the time.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::{Ipv4Addr, TcpListener};
use std::ops::Range;

/// The ports [`free_loopback_port`] picks from: registered ports below every
/// common OS's ephemeral range.
pub const PORTS: Range<u16> = 20_000..32_768;

/// A random port in [`PORTS`] that nothing listens on at `127.0.0.1` at the
/// time of the call, for a server under test to bind next.
///
/// # Panics
///
/// If no port in [`PORTS`] is free after 1,000 tries.
#[must_use]
pub fn free_loopback_port() -> u16 {
    let span = u64::from(PORTS.end - PORTS.start);
    (0..1_000)
        .map(|_| {
            // `RandomState` is seeded randomly per instance: a random number
            // with the standard library alone.
            let random = RandomState::new().build_hasher().finish();
            PORTS.start + u16::try_from(random % span).expect("the span fits in a port")
        })
        .find(|&port| TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok())
        .expect("a free loopback port below the ephemeral range")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_below_the_ephemeral_range_and_bindable() {
        let port = free_loopback_port();
        assert!(PORTS.contains(&port));
        TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("the port is free");
    }
}
