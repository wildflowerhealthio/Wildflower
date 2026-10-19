//! End-to-end tests of the front over real sockets: a rustls client's hello
//! goes in on one side, and on the other an in-process rathole server takes
//! the front's visitors and a rathole client hands each tunnel's visitor
//! streams to the test in place of a device. The relay's own site is served
//! with a self-signed certificate in place of the ACME one.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use std::sync::{Mutex, PoisonError};

use rathole::{AsyncStream, ClientServiceEvent};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::sign::{CertifiedKey, SingleCertAndKey};
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;
use wildflowerhealthio_kitchen_sink::loopback_port::free_loopback_port;
use wildflowerhealthio_rathole_settings::{NoisePattern, PublicRatholeSettings, Transport};
use wildflowerhealthio_relay_server::{
    ConnectionOutcomes, Front, Limits, Outcome, RelaySettings, Router, Secret, ServedTunnels, Site,
    SqliteTunnelStore, StoredTunnel, Tunnel, TunnelOutcome, TunnelRegistry, TunnelStore, Tunnels,
    Verifier,
};

/// The tunnel every test that pipes bytes routes to, and its token.
const TUNNEL: &str = "abc";
const TUNNEL_TOKEN: &str = "abc-token";

const DOMAIN: &str = "relay.example.com";
const WAIT: Duration = Duration::from_secs(5);

/// The ClientHello a real rustls client sends for `host`.
fn client_hello(host: &str) -> Vec<u8> {
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_root_certificates(RootCertStore::empty())
            .with_no_client_auth();
    let name = ServerName::try_from(host.to_owned()).expect("dns name");
    let mut conn = ClientConnection::new(Arc::new(config), name).expect("client");
    let mut hello = Vec::new();
    while conn.wants_write() {
        conn.write_tls(&mut hello).expect("write hello");
    }
    hello
}

/// What the front routes by, and records each connection's outcome into.
struct Routing {
    router: Arc<Router>,
    outcomes: Arc<ConnectionOutcomes>,
}

/// A router with the relay's domain as its one local hostname, serving the
/// tunnels named `tunnel_names`, and outcomes for them.
fn router(tunnel_names: &[&str]) -> Routing {
    let tunnels: Vec<_> = tunnel_names
        .iter()
        .map(|name| Tunnel {
            name: (*name).to_owned(),
            token: Secret::new(format!("{name}-token")),
        })
        .collect();
    let tunnels = Arc::new(ServedTunnels::new(&tunnels));
    Routing {
        router: Arc::new(Router::new(
            DOMAIN,
            [DOMAIN.to_owned()],
            Arc::clone(&tunnels),
        )),
        outcomes: Arc::new(ConnectionOutcomes::new(tunnels)),
    }
}

/// The relay's site with a self-signed certificate for [`DOMAIN`], and that
/// certificate for clients to trust.
fn self_signed_site() -> (Site, CertificateDer<'static>) {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec![DOMAIN.to_owned()]).expect("self-signed cert");
    let cert = cert.der().clone();
    let key = CertifiedKey::from_der(
        vec![cert.clone()],
        PrivateKeyDer::Pkcs8(signing_key.serialize_der().into()),
        &rustls::crypto::ring::default_provider(),
    )
    .expect("certified key");
    let rathole_settings = PublicRatholeSettings {
        remote_addr: format!("{DOMAIN}:2333"),
        transport: Transport::Noise,
        noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
        public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
        domain: DOMAIN.to_owned(),
    };
    (
        Site::new(
            Arc::new(SingleCertAndKey::from(key)),
            rathole_settings,
            Arc::new(Verifier::new(Arc::default(), None)),
            None,
        ),
        cert,
    )
}

/// A running front on ephemeral ports. Dropping it leaves the tasks to end
/// with the test runtime.
struct Harness {
    https: SocketAddr,
    http: SocketAddr,
    /// The site's certificate.
    site_cert: CertificateDer<'static>,
    /// What the front recorded about each connection.
    outcomes: Arc<ConnectionOutcomes>,
    shutdown_tx: broadcast::Sender<bool>,
}

/// A rathole server holding the tunnel [`TUNNEL`], with a client connected
/// to it: the front's visitors of the tunnel come out of `backend`, as the
/// device would take them.
struct ConnectedTunnel {
    tunnels: Tunnels,
    backend: mpsc::Receiver<Box<dyn AsyncStream>>,
    /// Stops the server and the client when dropped.
    _shutdown_tx: broadcast::Sender<bool>,
}

async fn start_tunnel() -> ConnectedTunnel {
    let control_port = free_loopback_port();
    // Neither address is used: the server and the client both run with a
    // visitor queue.
    let server_config = format!(
        "[server]\nbind_addr = \"127.0.0.1:{control_port}\"\n\
         [server.services.{TUNNEL}]\nbind_addr = \"\"\ntoken = \"{TUNNEL_TOKEN}\"\n"
    );
    let client_config = format!(
        "[client]\nremote_addr = \"127.0.0.1:{control_port}\"\n\
         [client.services.{TUNNEL}]\nlocal_addr = \"\"\ntoken = \"{TUNNEL_TOKEN}\"\n"
    );
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    let tunnels = Tunnels::default();
    // The tunnel stays as it is, so no change is sent.
    let (_, changes) = mpsc::channel(1);
    tokio::spawn(tunnels.clone().serve(
        server_config.parse().unwrap(),
        changes,
        shutdown_rx.resubscribe(),
    ));
    let mut backend = start_device(&client_config, shutdown_rx).await;
    until_connected(&tunnels, TUNNEL, &mut backend).await;
    ConnectedTunnel {
        tunnels,
        backend,
        _shutdown_tx: shutdown_tx,
    }
}

/// Run a rathole client on `client_config`, with one service, until
/// `shutdown_rx` fires, and return the queue its visitors come out of.
async fn start_device(
    client_config: &str,
    shutdown_rx: broadcast::Receiver<bool>,
) -> mpsc::Receiver<Box<dyn AsyncStream>> {
    let (_, update_rx) = mpsc::channel(1);
    let (event_tx, mut events) = mpsc::unbounded_channel();
    tokio::spawn(rathole::run_client_with_visitor_queue(
        client_config.parse().unwrap(),
        shutdown_rx,
        update_rx,
        event_tx,
        // The device takes no notice of its control channel's state.
        mpsc::unbounded_channel().0,
    ));
    // The client reports its one service as soon as it starts it.
    let Some(ClientServiceEvent::TcpStarted {
        visitor_stream_rx, ..
    }) = events.recv().await
    else {
        panic!("the client starts the tunnel's service");
    };
    visitor_stream_rx
}

/// Wait until the client behind `backend` takes the tunnel `name`'s
/// visitors. Once a visitor goes through, the client is connected. That
/// visitor is not part of any test.
async fn until_connected(
    tunnels: &Tunnels,
    name: &str,
    backend: &mut mpsc::Receiver<Box<dyn AsyncStream>>,
) {
    let connected = async {
        loop {
            let (_visitor, stream) = tokio::io::duplex(64);
            if tunnels.connect(name, stream).await.is_ok() {
                return backend.recv().await;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(WAIT, connected)
        .await
        .expect("the client should connect")
        .expect("the client hands over the first visitor");
}

/// Tunnels with no rathole server behind them: every tunnel is down.
fn no_tunnels() -> Tunnels {
    Tunnels::default()
}

/// The limits the tests run the front with: a 2 s hello deadline.
fn test_limits() -> Limits {
    Limits {
        hello_timeout: Duration::from_secs(2),
        ..Limits::default()
    }
}

async fn start_front(routing: Routing, tunnels: Tunnels) -> Harness {
    start_front_with(routing, tunnels, test_limits()).await
}

async fn start_front_with(routing: Routing, tunnels: Tunnels, limits: Limits) -> Harness {
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    let https = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (site, site_cert) = self_signed_site();
    let harness = Harness {
        https: https.local_addr().unwrap(),
        http: http.local_addr().unwrap(),
        site_cert,
        outcomes: Arc::clone(&routing.outcomes),
        shutdown_tx,
    };
    let front = Front::new(routing.router, tunnels, site, limits, routing.outcomes);
    tokio::spawn(Arc::clone(&front).serve_https(https, shutdown_rx.resubscribe()));
    tokio::spawn(front.serve_http(http, shutdown_rx));
    harness
}

/// Read exactly `len` bytes, failing the test on timeout.
async fn read_exact(stream: &mut (impl AsyncRead + Unpin), len: usize) -> Vec<u8> {
    let mut buf = vec![0; len];
    tokio::time::timeout(WAIT, stream.read_exact(&mut buf))
        .await
        .expect("timed out reading")
        .expect("read");
    buf
}

/// Read the PROXY v2 header off `stream` and return the source address it
/// carries.
async fn read_proxy_header(stream: &mut (impl AsyncRead + Unpin)) -> ppp::v2::Addresses {
    // 12-byte signature, version/command, family/protocol, 2-byte length.
    let mut header = read_exact(stream, 16).await;
    let len = usize::from(u16::from_be_bytes([header[14], header[15]]));
    header.extend(read_exact(stream, len).await);
    let parsed = ppp::v2::Header::try_from(header.as_slice()).expect("PROXY v2 header");
    assert_eq!(parsed.command, ppp::v2::Command::Proxy);
    parsed.addresses
}

/// Assert the front closes `stream` without writing anything to it.
async fn assert_closed_silently(mut stream: TcpStream) {
    let mut buf = [0u8; 64];
    let read = tokio::time::timeout(WAIT, stream.read(&mut buf))
        .await
        .expect("front should close the connection");
    match read {
        Ok(0) => {}
        Ok(n) => panic!("front wrote {n} bytes before closing"),
        // A reset (we sent bytes it never read) is also a silent close.
        Err(e) => assert_eq!(e.kind(), std::io::ErrorKind::ConnectionReset),
    }
}

/// How many connections `outcomes` has counted with `outcome`, not yet
/// flushed.
fn total(outcomes: &ConnectionOutcomes, outcome: Outcome) -> u64 {
    outcomes
        .pending()
        .iter()
        .filter(|counted| counted.outcome == outcome)
        .map(|counted| counted.count)
        .sum()
}

/// Wait until `holds` does, failing the test after [`WAIT`]. The front
/// records a piped connection's outcome on its own task, as the bytes go
/// through.
async fn eventually(holds: impl Fn() -> bool) {
    let waited = async {
        while !holds() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(WAIT, waited)
        .await
        .expect("the condition should hold");
}

/// Connect a client, send the hello for `host` plus `extra`, and take the
/// matching connection off `tunnel`. Checks the PROXY header names the
/// client and the replayed bytes are exactly what was sent.
async fn pipe_through(
    harness: &Harness,
    tunnel: &mut ConnectedTunnel,
    host: &str,
    extra: &[u8],
) -> (TcpStream, Box<dyn AsyncStream>) {
    let mut client = TcpStream::connect(harness.https).await.unwrap();
    let mut sent = client_hello(host);
    sent.extend_from_slice(extra);
    client.write_all(&sent).await.unwrap();

    let mut upstream = tokio::time::timeout(WAIT, tunnel.backend.recv())
        .await
        .expect("front should hand the visitor to the tunnel")
        .expect("the tunnel's client is running");
    let client_addr = client.local_addr().unwrap();
    let ppp::v2::Addresses::IPv4(addresses) = read_proxy_header(&mut upstream).await else {
        panic!("expected IPv4 addresses");
    };
    assert_eq!(
        SocketAddr::from((addresses.source_address, addresses.source_port)),
        client_addr
    );
    assert_eq!(
        SocketAddr::from((addresses.destination_address, addresses.destination_port)),
        harness.https
    );
    assert_eq!(read_exact(&mut upstream, sent.len()).await, sent);
    (client, upstream)
}

#[tokio::test]
async fn pipes_hello_and_bytes_both_ways_behind_a_proxy_header() {
    let mut tunnel = start_tunnel().await;
    let router = router(&[TUNNEL]);
    let harness = start_front(router, tunnel.tunnels.clone()).await;

    let (mut client, mut upstream) =
        pipe_through(&harness, &mut tunnel, "ABC.relay.example.com", b"early").await;
    eventually(|| harness.outcomes.last_outcome(TUNNEL) == Some(TunnelOutcome::Ok)).await;
    assert_eq!(total(&harness.outcomes, Outcome::Ok), 1);

    upstream.write_all(b"server bytes").await.unwrap();
    assert_eq!(read_exact(&mut client, 12).await, b"server bytes");
    client.write_all(b"client bytes").await.unwrap();
    assert_eq!(read_exact(&mut upstream, 12).await, b"client bytes");

    // Closing one side closes the other.
    drop(upstream);
    let mut rest = Vec::new();
    tokio::time::timeout(WAIT, client.read_to_end(&mut rest))
        .await
        .expect("client side should close")
        .unwrap();
    assert!(rest.is_empty());
    // Bytes through the pipe are not counted.
    assert_eq!(total(&harness.outcomes, Outcome::Ok), 1);
    let _ = harness.shutdown_tx.send(true);
}

/// Read until EOF, failing the test on timeout, and return what came.
async fn read_to_eof(stream: &mut (impl AsyncRead + Unpin)) -> Vec<u8> {
    let mut rest = Vec::new();
    tokio::time::timeout(WAIT, stream.read_to_end(&mut rest))
        .await
        .expect("the stream should reach EOF")
        .unwrap();
    rest
}

#[tokio::test]
async fn half_close_reaches_the_other_side_in_both_directions() {
    let mut tunnel = start_tunnel().await;
    let router = router(&[TUNNEL]);
    let harness = start_front(router, tunnel.tunnels.clone()).await;

    // The visitor finishes sending first; the device still answers.
    let (mut client, mut upstream) =
        pipe_through(&harness, &mut tunnel, "abc.relay.example.com", b"").await;
    client.write_all(b"request").await.unwrap();
    client.shutdown().await.unwrap();
    assert_eq!(read_to_eof(&mut upstream).await, b"request");
    upstream.write_all(b"response").await.unwrap();
    upstream.shutdown().await.unwrap();
    assert_eq!(read_to_eof(&mut client).await, b"response");

    // The device finishes sending first; the visitor can still send.
    let (mut client, mut upstream) =
        pipe_through(&harness, &mut tunnel, "abc.relay.example.com", b"").await;
    upstream.write_all(b"goodbye").await.unwrap();
    upstream.shutdown().await.unwrap();
    assert_eq!(read_to_eof(&mut client).await, b"goodbye");
    client.write_all(b"last words").await.unwrap();
    client.shutdown().await.unwrap();
    assert_eq!(read_to_eof(&mut upstream).await, b"last words");
    let _ = harness.shutdown_tx.send(true);
}

#[tokio::test]
async fn unknown_tunnel_is_closed_without_a_byte_written() {
    let harness = start_front(router(&[]), no_tunnels()).await;

    for host in [
        "nobody.relay.example.com",
        "abc.other.example.com",
        "a.b.relay.example.com",
    ] {
        let mut client = TcpStream::connect(harness.https).await.unwrap();
        client.write_all(&client_hello(host)).await.unwrap();
        assert_closed_silently(client).await;
    }
    eventually(|| total(&harness.outcomes, Outcome::UnknownTunnel) == 3).await;
    assert_eq!(harness.outcomes.last_outcome("nobody"), None);

    let mut garbage = TcpStream::connect(harness.https).await.unwrap();
    garbage
        .write_all(b"GET / HTTP/1.1\r\nHost: abc.relay.example.com\r\n\r\n")
        .await
        .unwrap();
    assert_closed_silently(garbage).await;
    eventually(|| total(&harness.outcomes, Outcome::NotAHello) == 1).await;
}

#[tokio::test]
async fn a_hello_without_a_server_name_is_counted_and_closed() {
    let harness = start_front(router(&[TUNNEL]), no_tunnels()).await;

    // rustls sends no SNI for an IP literal.
    let mut client = TcpStream::connect(harness.https).await.unwrap();
    client.write_all(&client_hello("127.0.0.1")).await.unwrap();
    assert_closed_silently(client).await;

    eventually(|| total(&harness.outcomes, Outcome::NoServerName) == 1).await;
    assert_eq!(harness.outcomes.last_outcome(TUNNEL), None);
}

#[tokio::test]
async fn a_connection_over_the_limit_is_counted_and_closed() {
    let limits = Limits {
        max_connections: 1,
        ..test_limits()
    };
    let harness = start_front_with(router(&[]), no_tunnels(), limits).await;

    // The first connection holds the one slot until its hello deadline.
    let _held = TcpStream::connect(harness.https).await.unwrap();
    let over = TcpStream::connect(harness.https).await.unwrap();
    assert_closed_silently(over).await;

    eventually(|| total(&harness.outcomes, Outcome::OverConnectionLimit) == 1).await;
}

#[tokio::test]
async fn known_tunnel_that_is_down_is_closed_silently() {
    // A tunnel whose device never connected has no visitor queue.
    let harness = start_front(router(&[TUNNEL]), no_tunnels()).await;

    let mut client = TcpStream::connect(harness.https).await.unwrap();
    client
        .write_all(&client_hello("abc.relay.example.com"))
        .await
        .unwrap();
    assert_closed_silently(client).await;

    eventually(|| harness.outcomes.last_outcome(TUNNEL) == Some(TunnelOutcome::TunnelDown)).await;
    assert_eq!(total(&harness.outcomes, Outcome::TunnelDown), 1);
}

#[tokio::test]
async fn silent_client_is_dropped_after_the_hello_deadline() {
    let harness = start_front(router(&[]), no_tunnels()).await;
    // Connect and send nothing; the 2 s test deadline closes it.
    let client = TcpStream::connect(harness.https).await.unwrap();
    assert_closed_silently(client).await;
    eventually(|| total(&harness.outcomes, Outcome::HelloTimeout) == 1).await;
}

async fn http_get(addr: SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    tokio::time::timeout(WAIT, stream.read_to_string(&mut response))
        .await
        .expect("http response")
        .unwrap();
    response
}

#[tokio::test]
async fn http_redirects_known_tunnels_and_404s_the_rest() {
    let harness = start_front(router(&[TUNNEL]), no_tunnels()).await;

    let response = http_get(
        harness.http,
        "GET /fhir/Patient?_count=1 HTTP/1.1\r\nHost: ABC.relay.example.com:80\r\n\r\n",
    )
    .await;
    assert!(
        response.starts_with("HTTP/1.1 308 "),
        "unexpected response: {response}"
    );
    assert!(
        response.contains("\r\nLocation: https://abc.relay.example.com/fhir/Patient?_count=1\r\n"),
        "unexpected response: {response}"
    );

    let response = http_get(
        harness.http,
        "GET /health HTTP/1.1\r\nHost: Relay.Example.com\r\n\r\n",
    )
    .await;
    assert!(
        response.starts_with("HTTP/1.1 308 ")
            && response.contains("\r\nLocation: https://relay.example.com/health\r\n"),
        "unexpected response: {response}"
    );

    for request in [
        "GET / HTTP/1.1\r\nHost: nobody.relay.example.com\r\n\r\n",
        "GET / HTTP/1.1\r\nHost: abc.example.org\r\n\r\n",
        "GET / HTTP/1.1\r\n\r\n",
    ] {
        let response = http_get(harness.http, request).await;
        assert!(
            response.starts_with("HTTP/1.1 404 "),
            "unexpected response to {request:?}: {response}"
        );
    }
    // `:80` is never counted.
    assert!(harness.outcomes.pending().is_empty());
}

/// Complete a TLS handshake through the front for `host`, offering `alpn`
/// and trusting only the site's certificate.
async fn tls_connect(harness: &Harness, host: &str, alpn: &[&[u8]]) -> TlsStream<TcpStream> {
    let mut roots = RootCertStore::empty();
    roots.add(harness.site_cert.clone()).expect("site cert");
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
    config.alpn_protocols = alpn.iter().map(|protocol| protocol.to_vec()).collect();
    let tcp = TcpStream::connect(harness.https).await.unwrap();
    let name = ServerName::try_from(host.to_owned()).expect("dns name");
    tokio::time::timeout(
        WAIT,
        TlsConnector::from(Arc::new(config)).connect(name, tcp),
    )
    .await
    .expect("TLS handshake timed out")
    .expect("TLS handshake with the site")
}

#[tokio::test]
async fn own_hostname_is_served_by_the_site_over_tls() {
    // A tunnel is routable too, so the site is chosen by name, not by default.
    let mut tunnel = start_tunnel().await;
    let harness = start_front(router(&[TUNNEL]), tunnel.tunnels.clone()).await;

    let mut tls = tls_connect(&harness, "Relay.Example.com", &[b"h2", b"http/1.1"]).await;
    assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"http/1.1"[..]));
    tls.write_all(b"GET /health HTTP/1.1\r\nHost: relay.example.com\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    tokio::time::timeout(WAIT, tls.read_to_string(&mut response))
        .await
        .expect("site response")
        .unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    assert!(
        response.contains("content-type: application/health+json\r\n"),
        "{response}"
    );
    assert!(response.ends_with(r#"{"status":"pass"}"#), "{response}");
    // The relay's own site is not counted.
    assert!(harness.outcomes.pending().is_empty());

    // The tunnel still routes alongside the site.
    let (_client, _upstream) =
        pipe_through(&harness, &mut tunnel, "abc.relay.example.com", b"").await;
    let _ = harness.shutdown_tx.send(true);
}

#[tokio::test]
async fn acme_tls_alpn_handshake_for_own_hostname_reaches_the_site() {
    let harness = start_front(router(&[]), no_tunnels()).await;

    let mut tls = tls_connect(&harness, DOMAIN, &[b"acme-tls/1"]).await;
    assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"acme-tls/1"[..]));
    // A validation handshake is closed once it completes, without HTTP.
    let mut rest = Vec::new();
    tokio::time::timeout(WAIT, tls.read_to_end(&mut rest))
        .await
        .expect("site should close a validation handshake")
        .unwrap();
    assert!(rest.is_empty());
    let _ = harness.shutdown_tx.send(true);
}

/// A stored tunnel routes on the running front once its device connects,
/// over the relay's own rathole config and noise transport, and its
/// visitors are closed without a byte written until then. (Creating and
/// deleting one while the relay runs is only reachable through the admin
/// API's capabilities; the registry's unit tests run those against rathole.)
#[tokio::test]
async fn stored_tunnels_route_on_the_front_once_their_device_connects() {
    let state_dir = tempfile::tempdir().unwrap();
    let state_dir_path = state_dir.path().display().to_string();
    let control_addr = format!("127.0.0.1:{}", free_loopback_port());
    let settings = RelaySettings::from_lookup(|name| match name {
        "WILDFLOWER_RELAY_DOMAIN" => Some(DOMAIN.to_owned()),
        "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY" => {
            Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned())
        }
        "WILDFLOWER_RELAY_CONTROL_ADDR" => Some(control_addr.clone()),
        "WILDFLOWER_RELAY_STATE_DIR" => Some(state_dir_path.clone()),
        _ => None,
    })
    .unwrap();
    let store =
        SqliteTunnelStore::open(&state_dir.path().join(SqliteTunnelStore::FILE_NAME)).unwrap();
    store
        .insert_tunnel(&StoredTunnel {
            tunnel: Tunnel {
                name: "alice".to_owned(),
                token: Secret::new("alice-token"),
            },
            email: "alice@example.com".to_owned(),
            created_at: 1_700_000_000,
        })
        .unwrap();
    drop(store);
    let (registry, rathole) = TunnelRegistry::open(&settings).await.unwrap();
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    let tunnels = Tunnels::default();
    tokio::spawn(tunnels.clone().serve(
        rathole.initial_config,
        rathole.changes,
        shutdown_rx.resubscribe(),
    ));
    let routing = Routing {
        router: registry.router(),
        outcomes: registry.outcomes(),
    };
    let harness = start_front(routing, tunnels.clone()).await;
    let public_host = format!("alice.{DOMAIN}");

    let mut offline = TcpStream::connect(harness.https).await.unwrap();
    offline
        .write_all(&client_hello(&public_host))
        .await
        .unwrap();
    assert_closed_silently(offline).await;

    // The device takes the public key from what `GET /rathole` serves.
    let public = settings.public_rathole_settings();
    let client_config = format!(
        "[client]\nremote_addr = \"{control_addr}\"\n\
         [client.transport]\ntype = \"noise\"\n\
         [client.transport.noise]\nremote_public_key = \"{}\"\n\
         [client.services.alice]\nlocal_addr = \"\"\ntoken = \"alice-token\"\n",
        public.public_key
    );
    let backend = start_device(&client_config, shutdown_rx).await;
    let mut tunnel = ConnectedTunnel {
        tunnels,
        backend,
        _shutdown_tx: shutdown_tx,
    };
    until_connected(&tunnel.tunnels, "alice", &mut tunnel.backend).await;
    let (_client, _upstream) = pipe_through(&harness, &mut tunnel, &public_host, b"").await;
    let _ = harness.shutdown_tx.send(true);
}

/// Lines a log layer writes, kept in memory.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Captured {
    fn text(&self) -> String {
        let bytes = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for Captured {
    type Writer = Self;

    fn make_writer(&'writer self) -> Self {
        self.clone()
    }
}

/// The ClientHello a rustls client offering `alpn` sends for the DNS name
/// `stand_in`, with that name swapped for `ip`, which must be as long:
/// rustls never sends an IP as the server name, but a scanner may.
fn client_hello_naming_ip(stand_in: &str, ip: &str, alpn: &[&[u8]]) -> Vec<u8> {
    assert_eq!(stand_in.len(), ip.len());
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_root_certificates(RootCertStore::empty())
            .with_no_client_auth();
    config.alpn_protocols = alpn.iter().map(|protocol| protocol.to_vec()).collect();
    let name = ServerName::try_from(stand_in.to_owned()).expect("dns name");
    let mut conn = ClientConnection::new(Arc::new(config), name).expect("client");
    let mut hello = Vec::new();
    while conn.wants_write() {
        conn.write_tls(&mut hello).expect("write hello");
    }
    let at = hello
        .windows(stand_in.len())
        .position(|window| window == stand_in.as_bytes())
        .expect("the name is in the hello");
    hello[at..at + ip.len()].copy_from_slice(ip.as_bytes());
    hello
}

/// Each refusal the front can reach over a socket is one line in the
/// connection log, naming the visitor's address, its outcome and its
/// detail, and none of it reaches the journal. (A busy or closed tunnel and
/// a PROXY header that cannot be built are covered by `front::refusal`'s
/// unit tests.)
///
/// The subscriber is the process's global one, not one scoped to this test:
/// with a single scoped subscriber, tracing works out which events are wanted
/// from whichever thread first reaches an event, so another test's thread
/// could switch this one's events off. Every other test in this file logs
/// into it too, so the journal is checked across all of them.
#[tokio::test]
async fn each_refusal_names_the_visitor_only_in_the_connection_log() {
    use tracing_subscriber::layer::SubscriberExt;

    let (journal, connection_log) = (Captured::default(), Captured::default());
    let subscriber =
        tracing_subscriber::registry().with(wildflowerhealthio_relay_server::logging::layers(
            "debug",
            journal.clone(),
            connection_log.clone(),
        ));
    tracing::subscriber::set_global_default(subscriber)
        .expect("no other test sets a global subscriber");
    let harness = start_front(router(&[TUNNEL]), no_tunnels()).await;
    let limits = Limits {
        max_connections: 1,
        ..test_limits()
    };
    let full = start_front_with(router(&[]), no_tunnels(), limits).await;

    // The connection log's line for the connection from `visitor`, once it
    // is written.
    let line_for = |visitor: SocketAddr| {
        let connection_log = connection_log.clone();
        async move {
            let marker = format!("visitor={visitor} ");
            let find = || {
                connection_log
                    .text()
                    .lines()
                    .find(|line| line.contains(&marker))
                    .map(str::to_owned)
            };
            eventually(|| find().is_some()).await;
            find().unwrap()
        }
    };
    let mut visitors = Vec::new();
    let mut check = |line: String, visitor: SocketAddr, outcome: &str, detail: &[&str]| {
        assert!(line.contains(" INFO "), "{line}");
        assert!(line.contains(&format!("outcome={outcome} ")), "{line}");
        assert!(line.contains(" elapsed="), "{line}");
        for detail in detail {
            assert!(line.contains(detail), "{detail}: {line}");
        }
        visitors.push(visitor);
    };

    // A client that is not speaking TLS.
    let mut client = TcpStream::connect(harness.https).await.unwrap();
    let visitor = client.local_addr().unwrap();
    client
        .write_all(b"GET / HTTP/1.1\r\nHost: abc.relay.example.com\r\n\r\n")
        .await
        .unwrap();
    assert_closed_silently(client).await;
    check(
        line_for(visitor).await,
        visitor,
        "not_a_hello",
        &[r#"first_bytes="GET / HTTP/1.1\r\nHost: abc.relay.""#],
    );

    // A client that closes without sending anything.
    let mut client = TcpStream::connect(harness.https).await.unwrap();
    let visitor = client.local_addr().unwrap();
    client.shutdown().await.unwrap();
    assert_closed_silently(client).await;
    check(
        line_for(visitor).await,
        visitor,
        "not_a_hello",
        &[r#"first_bytes="""#, "closed before a whole ClientHello"],
    );

    // A hello with an IP literal for its server name.
    let mut client = TcpStream::connect(harness.https).await.unwrap();
    let visitor = client.local_addr().unwrap();
    client
        .write_all(&client_hello_naming_ip(
            "abcdef.com",
            "192.0.2.10",
            &[b"h2", b"http/1.1"],
        ))
        .await
        .unwrap();
    assert_closed_silently(client).await;
    check(
        line_for(visitor).await,
        visitor,
        "no_server_name",
        &["sni_ip=192.0.2.10 ", r#"alpn=["h2", "http/1.1"]"#],
    );

    // A name no tunnel has.
    let mut client = TcpStream::connect(harness.https).await.unwrap();
    let visitor = client.local_addr().unwrap();
    client
        .write_all(&client_hello("nobody.relay.example.com"))
        .await
        .unwrap();
    assert_closed_silently(client).await;
    check(
        line_for(visitor).await,
        visitor,
        "unknown_tunnel",
        &["server_name=nobody.relay.example.com"],
    );

    // A tunnel whose device is not connected.
    let mut client = TcpStream::connect(harness.https).await.unwrap();
    let visitor = client.local_addr().unwrap();
    client
        .write_all(&client_hello("abc.relay.example.com"))
        .await
        .unwrap();
    assert_closed_silently(client).await;
    check(
        line_for(visitor).await,
        visitor,
        "tunnel_down",
        &["tunnel=abc", "refused: tunnel is down"],
    );

    // Three bytes of a hello, and then nothing until the deadline.
    let mut client = TcpStream::connect(harness.https).await.unwrap();
    let visitor = client.local_addr().unwrap();
    client.write_all(&[0x16, 0x03, 0x01]).await.unwrap();
    assert_closed_silently(client).await;
    check(
        line_for(visitor).await,
        visitor,
        "hello_timeout",
        &["bytes_received=3"],
    );

    // A connection while the front's one slot is held.
    let held = TcpStream::connect(full.https).await.unwrap();
    let over = TcpStream::connect(full.https).await.unwrap();
    let visitor = over.local_addr().unwrap();
    assert_closed_silently(over).await;
    check(
        line_for(visitor).await,
        visitor,
        "over_connection_limit",
        &[],
    );
    drop(held);

    let journal = journal.text();
    for visitor in visitors {
        assert!(!journal.contains(&visitor.to_string()), "{journal}");
    }
    for name in [TUNNEL, "nobody", "192.0.2.10", "127.0.0.1", "GET /"] {
        assert!(!journal.contains(name), "{name}: {journal}");
    }
    let _ = harness.shutdown_tx.send(true);
    let _ = full.shutdown_tx.send(true);
}
