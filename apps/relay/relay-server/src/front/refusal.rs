//! Why the front refused a `:443` connection, and its line in the
//! connection log.
//!
//! A [`Refusal`] is the [`Outcome`] the connection is counted as, plus what
//! the connection log says about it: the bytes that arrived, the server
//! name asked for, the tunnel. [`Front::refuse`] logs it and counts it.
//! The line is one `info` event with [`IDENTIFYING`], so it goes to the
//! connection log and never to the journal: the visitor's `ip:port`, the
//! outcome's name, how long the connection lasted, and the refusal's
//! detail. The count keeps only the outcome.
//!
//! Connections that reach a device, and those for the relay's own
//! hostnames, are not logged.

use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::time::Instant;

use super::hello::UnnamedHello;
use super::Front;
use crate::domain::{Outcome, TunnelOutcome};
use crate::logging::IDENTIFYING;
use crate::route::Route;

/// How many of a connection's first bytes the connection log keeps when
/// they are not a ClientHello: enough to tell `GET / HTTP/1.1` from
/// `SSH-2.0-…`, and no more.
pub(super) const FIRST_BYTES_KEPT: usize = 32;

/// A `:443` connection just accepted: where from, and when.
#[derive(Debug, Clone, Copy)]
pub(super) struct Visitor {
    pub(super) address: SocketAddr,
    pub(super) accepted_at: Instant,
}

/// Why the front refused a `:443` connection, with the detail the
/// connection log keeps about it.
#[derive(Debug)]
pub(super) enum Refusal {
    /// See [`Outcome::OverConnectionLimit`].
    OverConnectionLimit,
    /// See [`Outcome::HelloTimeout`].
    HelloTimeout {
        /// How many bytes arrived before the deadline (0 for a bare
        /// connect).
        bytes_received: usize,
    },
    /// See [`Outcome::NotAHello`].
    NotAHello {
        /// What arrived, if anything.
        first_bytes: FirstBytes,
        /// Why reading stopped.
        ended: NotAHello,
    },
    /// See [`Outcome::NoServerName`].
    NoServerName(UnnamedHello),
    /// See [`Outcome::UnknownTunnel`].
    UnknownTunnel {
        /// The server name the hello asked for, a DNS name lowercased by
        /// rustls.
        server_name: String,
    },
    /// A refusal at a known tunnel: see [`TunnelRefusal`].
    AtTunnel {
        tunnel_name: String,
        refusal: TunnelRefusal,
    },
}

/// Why reading a connection's first bytes ended without a ClientHello.
#[derive(Debug)]
pub(super) enum NotAHello {
    /// The bytes are not a ClientHello, or one rustls rejects.
    Invalid,
    /// The client closed before a whole hello arrived.
    Closed,
    /// Reading the socket failed.
    ReadFailed(io::Error),
}

/// Why a connection routed to a known tunnel did not reach it.
#[derive(Debug)]
pub(super) enum TunnelRefusal {
    /// See [`TunnelOutcome::TunnelDown`].
    Down,
    /// See [`TunnelOutcome::TunnelBusy`].
    Busy,
    /// See [`TunnelOutcome::TunnelClosed`]: writing to the pipe failed.
    Closed(io::Error),
    /// See [`TunnelOutcome::ProxyHeaderFailed`].
    ProxyHeaderFailed(io::Error),
}

impl TunnelRefusal {
    /// The outcome the tunnel's connection is recorded as.
    pub(super) const fn outcome(&self) -> TunnelOutcome {
        match self {
            Self::Down => TunnelOutcome::TunnelDown,
            Self::Busy => TunnelOutcome::TunnelBusy,
            Self::Closed(_) => TunnelOutcome::TunnelClosed,
            Self::ProxyHeaderFailed(_) => TunnelOutcome::ProxyHeaderFailed,
        }
    }
}

impl Refusal {
    /// `refusal` of a connection routed to `route`'s tunnel.
    pub(super) fn at(route: Route, refusal: TunnelRefusal) -> Self {
        Self::AtTunnel {
            tunnel_name: route.tunnel_name,
            refusal,
        }
    }

    /// The outcome the connection is counted as.
    pub(super) fn outcome(&self) -> Outcome {
        match self {
            Self::OverConnectionLimit => Outcome::OverConnectionLimit,
            Self::HelloTimeout { .. } => Outcome::HelloTimeout,
            Self::NotAHello { .. } => Outcome::NotAHello,
            Self::NoServerName(_) => Outcome::NoServerName,
            Self::UnknownTunnel { .. } => Outcome::UnknownTunnel,
            Self::AtTunnel { refusal, .. } => refusal.outcome().into(),
        }
    }

    /// Write the refusal of `visitor`'s connection to the connection log.
    pub(super) fn log(&self, visitor: &Visitor) {
        /// One `info` line to the connection log, with the fields every
        /// refusal has, then `$detail`.
        macro_rules! refused {
            ($($detail:tt)+) => {
                tracing::info!(
                    target: IDENTIFYING,
                    visitor = %visitor.address,
                    outcome = %self.outcome().as_str(),
                    elapsed = ?visitor.accepted_at.elapsed(),
                    $($detail)+
                )
            };
        }
        match self {
            Self::OverConnectionLimit => refused!("refused: the front is at its connection limit"),
            Self::HelloTimeout { bytes_received } => {
                refused!(
                    bytes_received,
                    "refused: no ClientHello within the deadline"
                );
            }
            Self::NotAHello {
                first_bytes,
                ended: NotAHello::Invalid,
            } => refused!(%first_bytes, "refused: not a ClientHello"),
            Self::NotAHello {
                first_bytes,
                ended: NotAHello::Closed,
            } => refused!(%first_bytes, "refused: the client closed before a whole ClientHello"),
            Self::NotAHello {
                first_bytes,
                ended: NotAHello::ReadFailed(error),
            } => refused!(%first_bytes, %error, "refused: reading the ClientHello failed"),
            Self::NoServerName(hello) => refused!(
                sni_ip = %SniIp(hello),
                alpn = %Alpn(&hello.alpn),
                "refused: no server name"
            ),
            Self::UnknownTunnel { server_name } => {
                refused!(%server_name, "refused: unknown tunnel");
            }
            Self::AtTunnel {
                tunnel_name,
                refusal,
            } => match refusal {
                TunnelRefusal::Down => refused!(tunnel = %tunnel_name, "refused: tunnel is down"),
                TunnelRefusal::Busy => refused!(
                    tunnel = %tunnel_name,
                    "refused: the tunnel's visitor queue stayed full past the deadline"
                ),
                TunnelRefusal::Closed(error) => refused!(
                    tunnel = %tunnel_name,
                    %error,
                    "refused: tunnel closed before the hello was sent"
                ),
                TunnelRefusal::ProxyHeaderFailed(error) => refused!(
                    tunnel = %tunnel_name,
                    %error,
                    "refused: building the PROXY header failed"
                ),
            },
        }
    }
}

impl Front {
    /// Log `refusal` of `visitor`'s connection to the connection log, and
    /// record its outcome: as its tunnel's last outcome too, when it was
    /// refused at a tunnel.
    pub(super) fn refuse(&self, visitor: &Visitor, refusal: Refusal) {
        refusal.log(visitor);
        match refusal {
            Refusal::AtTunnel {
                tunnel_name,
                refusal,
            } => self
                .outcomes
                .record_for_tunnel(&tunnel_name, refusal.outcome()),
            other => self.outcomes.record(other.outcome()),
        }
    }
}

/// At most the first [`FIRST_BYTES_KEPT`] bytes a connection sent. Shown
/// quoted and escaped (`"GET / HTTP/1.1\r\n…"`): printable ASCII as itself,
/// anything else as `\r`, `\n`, `\xNN` and so on, so no byte the client
/// sent reaches the log raw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FirstBytes(Vec<u8>);

impl FirstBytes {
    /// The first [`FIRST_BYTES_KEPT`] of `received`.
    pub(super) fn of(received: &[u8]) -> Self {
        Self(received[..received.len().min(FIRST_BYTES_KEPT)].to_vec())
    }
}

impl fmt::Display for FirstBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "\"{}\"", self.0.escape_ascii())
    }
}

/// The IP literal a hello sent as its server name, or `none`.
struct SniIp<'a>(&'a UnnamedHello);

impl fmt::Display for SniIp<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0.sni_ip {
            Some(ip) => write!(f, "{ip}"),
            None => f.write_str("none"),
        }
    }
}

/// ALPN protocols as a list, each quoted and escaped as [`FirstBytes`]
/// is: `["h2", "http/1.1"]`.
struct Alpn<'a>(&'a [Vec<u8>]);

impl fmt::Display for Alpn<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[")?;
        for (i, protocol) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str(", ")?;
            }
            write!(f, "\"{}\"", protocol.escape_ascii())?;
        }
        f.write_str("]")
    }
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;
    use std::time::Duration;

    use tracing_subscriber::layer::SubscriberExt;

    use super::*;
    use crate::logging::layers;
    use crate::test_support::Captured;

    fn visitor() -> Visitor {
        Visitor {
            address: "203.0.113.7:51234".parse().unwrap(),
            accepted_at: Instant::now() - Duration::from_millis(1500),
        }
    }

    fn at_tunnel(refusal: TunnelRefusal) -> Refusal {
        Refusal::AtTunnel {
            tunnel_name: "alice".to_owned(),
            refusal,
        }
    }

    /// Every refusal, with the detail its line must carry.
    fn every_refusal() -> Vec<(Refusal, Vec<&'static str>)> {
        vec![
            (Refusal::OverConnectionLimit, vec![]),
            (
                Refusal::HelloTimeout { bytes_received: 3 },
                vec!["bytes_received=3"],
            ),
            (
                Refusal::NotAHello {
                    first_bytes: FirstBytes::of(b"SSH-2.0-OpenSSH_9.6\r\n"),
                    ended: NotAHello::Invalid,
                },
                vec![r#"first_bytes="SSH-2.0-OpenSSH_9.6\r\n""#],
            ),
            (
                Refusal::NotAHello {
                    first_bytes: FirstBytes::of(b""),
                    ended: NotAHello::Closed,
                },
                vec![r#"first_bytes="""#, "closed before a whole ClientHello"],
            ),
            (
                Refusal::NotAHello {
                    first_bytes: FirstBytes::of(b""),
                    ended: NotAHello::ReadFailed(io::Error::from(io::ErrorKind::ConnectionReset)),
                },
                vec![r#"first_bytes="""#, "error=connection reset"],
            ),
            (
                Refusal::NoServerName(UnnamedHello {
                    sni_ip: Some(IpAddr::from([192, 0, 2, 10])),
                    alpn: vec![b"h2".to_vec(), b"http/1.1".to_vec()],
                }),
                vec!["sni_ip=192.0.2.10", r#"alpn=["h2", "http/1.1"]"#],
            ),
            (
                Refusal::NoServerName(UnnamedHello::default()),
                vec!["sni_ip=none", "alpn=[]"],
            ),
            (
                Refusal::UnknownTunnel {
                    server_name: "nobody.relay.example.com".to_owned(),
                },
                vec!["server_name=nobody.relay.example.com"],
            ),
            (at_tunnel(TunnelRefusal::Down), vec!["tunnel=alice"]),
            (at_tunnel(TunnelRefusal::Busy), vec!["tunnel=alice"]),
            (
                at_tunnel(TunnelRefusal::Closed(io::Error::from(
                    io::ErrorKind::BrokenPipe,
                ))),
                vec!["tunnel=alice", "error=broken pipe"],
            ),
            (
                at_tunnel(TunnelRefusal::ProxyHeaderFailed(io::Error::other(
                    "mixed families",
                ))),
                vec!["tunnel=alice", "error=mixed families"],
            ),
        ]
    }

    #[test]
    fn every_refusal_is_one_connection_log_line_with_the_visitor_and_its_detail() {
        let refusals = every_refusal();
        let outcomes: std::collections::BTreeSet<Outcome> = refusals
            .iter()
            .map(|(refusal, _)| refusal.outcome())
            .collect();
        assert_eq!(
            outcomes.len(),
            Outcome::ALL.len() - 1,
            "every outcome but ok is covered"
        );

        for (refusal, detail) in refusals {
            let (journal, connection_log) = (Captured::default(), Captured::default());
            let subscriber = tracing_subscriber::registry().with(layers(
                "info",
                journal.clone(),
                connection_log.clone(),
            ));
            tracing::subscriber::with_default(subscriber, || refusal.log(&visitor()));

            let (journal, connection_log) = (journal.text(), connection_log.text());
            assert!(journal.is_empty(), "{journal}");
            assert_eq!(connection_log.lines().count(), 1, "{connection_log}");
            assert!(connection_log.contains(" INFO "), "{connection_log}");
            assert!(
                connection_log.contains("visitor=203.0.113.7:51234"),
                "{connection_log}"
            );
            let outcome = format!("outcome={} ", refusal.outcome().as_str());
            assert!(connection_log.contains(&outcome), "{connection_log}");
            assert!(connection_log.contains("elapsed=1.5"), "{connection_log}");
            for detail in detail {
                assert!(
                    connection_log.contains(detail),
                    "{detail}: {connection_log}"
                );
            }
        }
    }

    #[test]
    fn first_bytes_are_capped_and_escaped() {
        let mut sent = b"GET / HTTP/1.1\r\nHost: \"x\"\n\x00\x1b[2J\xff".to_vec();
        sent.extend_from_slice(&[b'A'; 64]);
        let first_bytes = FirstBytes::of(&sent);
        assert_eq!(first_bytes.0.len(), FIRST_BYTES_KEPT);
        let shown = first_bytes.to_string();
        assert_eq!(shown, r#""GET / HTTP/1.1\r\nHost: \"x\"\n\x00\x1b[2J\xff""#);
        assert!(
            shown
                .bytes()
                .all(|byte| byte.is_ascii_graphic() || byte == b' '),
            "{shown}"
        );

        assert_eq!(FirstBytes::of(b"ab").to_string(), r#""ab""#);
    }
}
