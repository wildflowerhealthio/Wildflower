//! One `:80` request: redirect the relay's own hostnames and known tunnels to
//! `https://`, 404 the rest.
//!
//! Only the request line and the `Host` header are read (the head is capped
//! at 8 KiB and must arrive within the hello deadline). Nothing is ever
//! proxied in plaintext.

use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::Front;
use crate::route::Destination;

/// Upper bound on an HTTP request head.
const MAX_HTTP_HEAD_BYTES: usize = 8 * 1024;

const NOT_FOUND: &str = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

impl Front {
    /// Answer one `:80` request with a redirect or a 404, then close.
    pub(super) async fn handle_http(&self, mut stream: TcpStream) {
        let read =
            tokio::time::timeout(self.limits.hello_timeout, read_http_head(&mut stream)).await;
        let Ok(Ok(Some(head))) = read else {
            return;
        };
        let response = match self.redirect_location(&head) {
            Some(location) => format!(
                "HTTP/1.1 308 Permanent Redirect\r\nLocation: {location}\r\n\
                 Content-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            None => NOT_FOUND.to_owned(),
        };
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    /// `https://<hostname><path>` if the request's host is one of the
    /// relay's local hostnames or names a known tunnel. The hostname is
    /// rebuilt from the route rather than echoing `Host`.
    fn redirect_location(&self, head: &[u8]) -> Option<String> {
        let (host, path) = parse_http_head(head)?;
        let hostname = match self.router.resolve(&host)? {
            Destination::Local(hostname) => hostname,
            Destination::Tunnel(route) => {
                format!("{}.{}", route.tunnel_name, self.router.domain())
            }
        };
        Some(format!("https://{hostname}{path}"))
    }
}

/// Read an HTTP request head (through the blank line), or `None` if the
/// peer closes first or it exceeds [`MAX_HTTP_HEAD_BYTES`].
async fn read_http_head(stream: &mut TcpStream) -> io::Result<Option<Vec<u8>>> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let chunk_len = chunk.len();
    loop {
        let room = MAX_HTTP_HEAD_BYTES - head.len();
        if room == 0 {
            return Ok(None);
        }
        let n = stream.read(&mut chunk[..room.min(chunk_len)]).await?;
        if n == 0 {
            return Ok(None);
        }
        head.extend_from_slice(&chunk[..n]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(Some(head));
        }
    }
}

/// The `Host` (without port) and origin-form path of an HTTP/1.x request
/// head, or `None` if either is missing or malformed. The path is echoed
/// into a `Location` header, so it must hold no whitespace or controls.
fn parse_http_head(head: &[u8]) -> Option<(String, String)> {
    let head = std::str::from_utf8(head).ok()?;
    let mut lines = head.split("\r\n");

    // Request line: `METHOD TARGET HTTP/1.x`.
    let mut parts = lines.next()?.split(' ');
    let (_method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !version.starts_with("HTTP/1.") {
        return None;
    }
    // An absolute-form target (`http://host/x`) redirects to `/`.
    let path = if target.starts_with('/') { target } else { "/" };
    if path.bytes().any(|b| b.is_ascii_control() || b == b' ') {
        return None;
    }

    // Headers, up to the blank line: find `Host`.
    let mut host = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("host") {
                host = Some(value.trim());
                break;
            }
        }
    }
    let host = strip_port(host?);
    Some((host.to_owned(), path.to_owned()))
}

/// `name:80` becomes `name`; anything without a numeric port is unchanged.
fn strip_port(host: &str) -> &str {
    match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_head_yields_host_without_port_and_path() {
        assert_eq!(
            parse_http_head(
                b"GET /a/b?c=d HTTP/1.1\r\nUser-Agent: x\r\nHOST: Abc.relay.example.com:80\r\n\r\n"
            ),
            Some(("Abc.relay.example.com".to_owned(), "/a/b?c=d".to_owned()))
        );
        assert_eq!(
            parse_http_head(b"GET http://abc.example/x HTTP/1.0\r\nHost: abc.example\r\n\r\n"),
            Some(("abc.example".to_owned(), "/".to_owned()))
        );
    }

    #[test]
    fn http_head_rejects_malformed_requests() {
        for head in [
            &b"GET / HTTP/1.1\r\n\r\n"[..],
            b"GET / HTTP/2\r\nHost: a\r\n\r\n",
            b"GET /\x7f HTTP/1.1\r\nHost: a\r\n\r\n",
            b"GET / HTTP/1.1 extra\r\nHost: a\r\n\r\n",
            b"\xff\xfe\r\n\r\n",
            b"",
        ] {
            assert_eq!(parse_http_head(head), None, "{head:?}");
        }
    }
}
