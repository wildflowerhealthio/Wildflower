//! HTTP Message Signatures (RFC 9421) with `hmac-sha256`, keyed by a
//! tunnel's token, so a device proves it holds the token without sending it.
//!
//! A signed route sits behind [`require_signature`], which buffers the body,
//! verifies the request with the site's [`Verifier`] and records who signed
//! it for the [`SignedBy`] extractor. Every verification failure is a bare
//! `401`; the reason is logged at `debug`, never the key.
//!
//! ## What a request must carry
//!
//! - `Signature-Input` with exactly one signature, e.g.
//!   `sig=("@method" "@target-uri");created=1700000000;nonce="…";keyid="<tunnel name>";alg="hmac-sha256"`,
//!   and `Signature` with the same label and the MAC as a byte sequence.
//! - Covered components: `@method` and `@target-uri` always, and
//!   `content-digest` whenever the request has a body. Other components
//!   (`@authority`, header fields) may be covered too; component parameters
//!   (`;sf`, `;key`, `;bs`, `;req`, …) are not supported.
//! - Parameters: `created` within [`CLOCK_SKEW_SECS`] of the relay's clock,
//!   a `nonce` not seen within that window, `keyid` and
//!   `alg="hmac-sha256"`. An `expires` in the past is rejected.
//! - `Content-Digest` (RFC 9530) with a `sha-256` member matching the body,
//!   whenever `content-digest` is covered.
//!
//! The key for `keyid="<tunnel name>"` is that tunnel's token, and for
//! `keyid="admin"` ([`ADMIN_KEY_ID`]) `WILDFLOWER_RELAY_ADMIN_KEY`; either
//! is used as its UTF-8 bytes, as written in the environment less
//! surrounding whitespace, not decoded.
//!
//! `@target-uri` is `https://<authority><path>[?<query>]`, where the
//! authority is the request's `Host`, lowercased and without `:443`, and
//! path and query are the request target as sent. That is how a URL
//! parser serializes the URL the client fetched, so a client signs the URL
//! it requests. `@authority` is the same authority.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderName, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use rathole_settings_rust::{TunnelName, ADMIN_KEY_ID};
use sfv::{BareItem, Dictionary, FieldType, InnerList, ListEntry, Parser};
use sha2::{Digest, Sha256};

use crate::served::ServedTunnels;
use crate::settings::Secret;

/// How far `created` may be from the relay's clock, either way, and so how
/// long a nonce is remembered.
pub const CLOCK_SKEW_SECS: i64 = 60;

/// The only `alg` accepted.
const ALG: &str = "hmac-sha256";

/// The largest body a signed route buffers to check its digest.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// The longest `nonce` accepted, so the nonce set stays small.
const MAX_NONCE_LEN: usize = 128;

/// How many nonces are remembered at once for each `keyid`. Only verified
/// requests add one, and each is kept until its `created` is stale, so this
/// bounds each signer to about this many signed requests per
/// `CLOCK_SKEW_SECS`; beyond it, that signer's requests are refused until
/// its old nonces expire. Other signers are unaffected.
const MAX_NONCES_PER_KEY: usize = 4_096;

/// Who signed a verified request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignedBy {
    /// The device holding this tunnel's token.
    Tunnel(TunnelName),
    /// The holder of `WILDFLOWER_RELAY_ADMIN_KEY`.
    Admin,
}

/// Checks signatures against the served tunnels' tokens and the admin key,
/// and remembers the nonces of the requests it has accepted. The tunnels
/// that can sign are the [`ServedTunnels`] it shares with the front's
/// router; [`Verifier::forget`] drops a removed tunnel's nonces.
pub struct Verifier {
    tunnels: Arc<ServedTunnels>,
    /// Signs for [`ADMIN_KEY_ID`], when set.
    admin_key: Option<Secret>,
    /// `keyid` → accepted nonce → the unix time after which its `created`
    /// is stale.
    nonces: Mutex<HashMap<String, HashMap<String, i64>>>,
}

impl std::fmt::Debug for Verifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Verifier").finish_non_exhaustive()
    }
}

impl Verifier {
    /// Each of `tunnels`' tokens signs for its name; `admin_key`, when set,
    /// signs for [`ADMIN_KEY_ID`].
    #[must_use]
    pub fn new(tunnels: Arc<ServedTunnels>, admin_key: Option<Secret>) -> Self {
        Self {
            tunnels,
            admin_key,
            nonces: Mutex::new(HashMap::new()),
        }
    }

    /// Forget the nonces of the tunnel named `name`, once it has been
    /// removed from the served tunnels. The other signers keep theirs.
    pub fn forget(&self, name: &str) {
        self.nonces
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(name);
    }

    /// The key that signs for `keyid`, if any. No tunnel may be named
    /// [`ADMIN_KEY_ID`].
    fn key(&self, keyid: &str) -> Option<Secret> {
        if keyid == ADMIN_KEY_ID {
            self.admin_key.clone()
        } else {
            self.tunnels.token(keyid)
        }
    }

    /// Verify `parts` and `body` at unix time `now`. The error is the
    /// reason, for logging only.
    fn verify(&self, parts: &Parts, body: &[u8], now: i64) -> Result<SignedBy, &'static str> {
        let signature = ReceivedSignature::from_headers(&parts.headers)?;
        let params = &signature.input.params;
        if params
            .get("alg")
            .and_then(BareItem::as_string)
            .map(|a| a.as_str())
            != Some(ALG)
        {
            return Err("alg is not hmac-sha256");
        }
        let keyid = params
            .get("keyid")
            .and_then(BareItem::as_string)
            .ok_or("no keyid")?
            .as_str();
        let created = params
            .get("created")
            .and_then(BareItem::as_integer)
            .map(i64::from)
            .ok_or("no created")?;
        if (now - created).abs() > CLOCK_SKEW_SECS {
            return Err("created is outside the clock skew window");
        }
        if let Some(expires) = params.get("expires") {
            if expires.as_integer().map(i64::from).is_none_or(|e| e < now) {
                return Err("expired");
            }
        }
        let nonce = params
            .get("nonce")
            .and_then(BareItem::as_string)
            .map(|n| n.as_str())
            .filter(|n| !n.is_empty() && n.len() <= MAX_NONCE_LEN)
            .ok_or("no usable nonce")?;
        let covers = |name: &str| signature.input.components.iter().any(|c| c == name);
        if !covers("@method") || !covers("@target-uri") {
            return Err("@method or @target-uri is not covered");
        }
        if !body.is_empty() && !covers("content-digest") {
            return Err("the body is not covered by content-digest");
        }
        let key = self.key(keyid).ok_or("unknown keyid")?;
        let base = signature_base(parts, &signature.input).ok_or("components unavailable")?;
        if !mac_is_valid(key.expose().as_bytes(), &base, &signature.mac)? {
            return Err("MAC mismatch");
        }
        if covers("content-digest") && !content_digest_matches(&parts.headers, body) {
            return Err("content-digest does not match the body");
        }
        self.remember_nonce(keyid, &key, nonce, created + CLOCK_SKEW_SECS, now)?;
        if keyid == ADMIN_KEY_ID {
            return Ok(SignedBy::Admin);
        }
        // Served tunnels were named by `TunnelName`'s rules, so this holds.
        let tunnel_name = TunnelName::parse(keyid).map_err(|_| "unknown keyid")?;
        Ok(SignedBy::Tunnel(tunnel_name))
    }

    /// Record `keyid`'s `nonce` until `stale_after`, refusing one already
    /// recorded, or any for a request checked with a `key` that no longer
    /// signs for `keyid`: its tunnel was removed since, even if one was
    /// created again under the same name. Checking that under the nonce
    /// lock means a tunnel removed and then [forgotten](Self::forget) keeps
    /// no nonce. When that key's set is full, its expired nonces are dropped
    /// first; if it is still full, the request is refused.
    fn remember_nonce(
        &self,
        keyid: &str,
        key: &Secret,
        nonce: &str,
        stale_after: i64,
        now: i64,
    ) -> Result<(), &'static str> {
        // A poisoned lock only means a holder panicked; the map is whole.
        let mut nonces = self.nonces.lock().unwrap_or_else(PoisonError::into_inner);
        if self.key(keyid).as_ref() != Some(key) {
            return Err("unknown keyid");
        }
        let nonces = nonces.entry(keyid.to_owned()).or_default();
        if nonces.get(nonce).is_some_and(|&until| until >= now) {
            return Err("replayed nonce");
        }
        if nonces.len() >= MAX_NONCES_PER_KEY {
            nonces.retain(|_, &mut until| until >= now);
            if nonces.len() >= MAX_NONCES_PER_KEY {
                return Err("nonce set is full");
            }
        }
        nonces.insert(nonce.to_owned(), stale_after);
        Ok(())
    }
}

/// Middleware for signed routes: buffer the body, verify the request and
/// record [`SignedBy`] for the handler, or answer `401`.
pub async fn require_signature(
    State(verifier): State<Arc<Verifier>>,
    request: Request,
    next: Next,
) -> Response {
    let now = match unix_now() {
        Ok(now) => now,
        Err(error) => {
            tracing::error!("cannot verify a signed request: reading the clock failed: {error:#}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let (mut parts, body) = request.into_parts();
    let Ok(body) = axum::body::to_bytes(body, MAX_BODY_BYTES).await else {
        tracing::debug!("signed request rejected: body unreadable or too large");
        return StatusCode::UNAUTHORIZED.into_response();
    };
    match verifier.verify(&parts, &body, now) {
        Ok(signed_by) => {
            parts.extensions.insert(signed_by);
            next.run(Request::from_parts(parts, Body::from(body))).await
        }
        Err(reason) => {
            tracing::debug!(reason, "signed request rejected");
            StatusCode::UNAUTHORIZED.into_response()
        }
    }
}

/// Seconds since the unix epoch.
///
/// # Errors
///
/// Returns an error if the clock reads before the epoch or past `i64`.
pub(crate) fn unix_now() -> anyhow::Result<i64> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
    Ok(i64::try_from(elapsed.as_secs())?)
}

impl<S: Send + Sync> FromRequestParts<S> for SignedBy {
    type Rejection = StatusCode;

    /// The signer [`require_signature`] verified. On a route without it,
    /// there is none, and the request is refused.
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<SignedBy>()
            .cloned()
            .ok_or(StatusCode::UNAUTHORIZED)
    }
}

/// One signature's `Signature-Input` entry.
#[derive(Debug)]
struct SignatureInput {
    /// Covered component identifiers, in order.
    components: Vec<String>,
    params: sfv::Parameters,
    /// The inner list serialized, the value of `"@signature-params"`.
    serialized: String,
}

/// The one signature a request carries: its input and its MAC.
#[derive(Debug)]
struct ReceivedSignature {
    input: SignatureInput,
    mac: Vec<u8>,
}

impl ReceivedSignature {
    /// Parse `Signature-Input` and `Signature`, which must each hold exactly
    /// one member, under the same label.
    fn from_headers(headers: &HeaderMap) -> Result<Self, &'static str> {
        let inputs = dictionary(headers, "signature-input").ok_or("bad Signature-Input")?;
        let signatures = dictionary(headers, "signature").ok_or("bad Signature")?;
        let (
            Some((label, ListEntry::InnerList(input))),
            Some((signature_label, ListEntry::Item(mac))),
        ) = (only_member(&inputs), only_member(&signatures))
        else {
            return Err("not exactly one signature");
        };
        if label != signature_label {
            return Err("Signature-Input and Signature labels differ");
        }
        let mac = mac
            .bare_item
            .as_byte_sequence()
            .ok_or("MAC is not a byte sequence")?;
        Ok(Self {
            input: SignatureInput::from_inner_list(input)?,
            mac: mac.to_vec(),
        })
    }
}

impl SignatureInput {
    fn from_inner_list(input: &InnerList) -> Result<Self, &'static str> {
        let mut components: Vec<String> = Vec::new();
        for item in &input.items {
            let name = item
                .bare_item
                .as_string()
                .filter(|_| item.params.is_empty())
                .ok_or("component is not a plain string")?
                .as_str();
            if components.iter().any(|c| c == name) {
                return Err("component listed twice");
            }
            components.push(name.to_owned());
        }
        let serialized = vec![ListEntry::InnerList(input.clone())]
            .serialize()
            .ok_or("empty signature input")?;
        Ok(Self {
            components,
            params: input.params.clone(),
            serialized,
        })
    }
}

/// The member of a dictionary that has exactly one.
fn only_member(dictionary: &Dictionary) -> Option<(&sfv::Key, &ListEntry)> {
    let mut members = dictionary.iter();
    let only = members.next()?;
    members.next().is_none().then_some(only)
}

/// A structured-field dictionary header, its lines joined.
fn dictionary(headers: &HeaderMap, name: &str) -> Option<Dictionary> {
    Parser::new(&field_value(headers, name)?).parse().ok()
}

/// A header's value as RFC 9421 §2.1 reads it: every line, trimmed, joined
/// with `, `. `None` if absent or not visible ASCII.
fn field_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let lines = headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().map(str::trim))
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (!lines.is_empty()).then(|| lines.join(", "))
}

/// The request's authority: `Host` (or an absolute-form target's
/// authority), lowercased, without the default `:443`. It is the authority
/// of `@target-uri`.
pub(super) fn authority(parts: &Parts) -> Option<String> {
    let host = match parts.uri.authority() {
        Some(authority) => authority.as_str(),
        None => parts.headers.get(header::HOST)?.to_str().ok()?,
    }
    .to_ascii_lowercase();
    Some(host.strip_suffix(":443").map(str::to_owned).unwrap_or(host))
}

/// The value of one covered component, or `None` if the request has no
/// such component (or it is one this relay does not derive).
fn component_value(parts: &Parts, name: &str) -> Option<String> {
    match name {
        "@method" => Some(parts.method.as_str().to_owned()),
        "@authority" => authority(parts),
        "@target-uri" => {
            let path_and_query = parts.uri.path_and_query().map_or("/", |pq| pq.as_str());
            Some(format!("https://{}{path_and_query}", authority(parts)?))
        }
        derived if derived.starts_with('@') => None,
        field => {
            // Field names are lowercase in a signature input.
            let field = HeaderName::from_bytes(field.as_bytes())
                .ok()
                .filter(|parsed| parsed.as_str() == field)?;
            field_value(&parts.headers, field.as_str())
        }
    }
}

/// The signature base (RFC 9421 §2.5): one `"<component>": <value>` line per
/// covered component, then `"@signature-params"`.
fn signature_base(parts: &Parts, input: &SignatureInput) -> Option<String> {
    let mut base = String::new();
    for name in &input.components {
        let value = component_value(parts, name)?;
        base.push_str(&format!("\"{name}\": {value}\n"));
    }
    base.push_str(&format!("\"@signature-params\": {}", input.serialized));
    Some(base)
}

/// Whether `mac` is the `hmac-sha256` of `base` under `key`, compared in
/// constant time.
fn mac_is_valid(key: &[u8], base: &str, mac: &[u8]) -> Result<bool, &'static str> {
    let mut hmac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| "unusable key")?;
    hmac.update(base.as_bytes());
    Ok(hmac.verify_slice(mac).is_ok())
}

/// Whether `Content-Digest` (RFC 9530) has a `sha-256` member equal to the
/// SHA-256 of `body`.
fn content_digest_matches(headers: &HeaderMap, body: &[u8]) -> bool {
    dictionary(headers, "content-digest")
        .as_ref()
        .and_then(|digests| match digests.get("sha-256") {
            Some(ListEntry::Item(item)) => item.bare_item.as_byte_sequence(),
            _ => None,
        })
        .is_some_and(|digest| digest == &Sha256::digest(body)[..])
}

#[cfg(test)]
pub(crate) mod tests {
    use axum::http::Request;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    use super::*;
    use crate::domain::Tunnel;

    /// A signed request for `method` `uri` (with its `Host` taken from the
    /// URI) carrying `body`, signed as `keyid` with `key` at `created`. The
    /// signature base is built by hand here, independently of the verifier.
    pub(crate) fn signed_request(
        method: &str,
        uri: &str,
        body: &[u8],
        keyid: &str,
        key: &str,
        created: i64,
        nonce: &str,
    ) -> Request<Body> {
        let (host, path) = uri
            .strip_prefix("https://")
            .and_then(|rest| rest.split_once('/'))
            .expect("https URL with a path");
        let mut components = r#""@method" "@target-uri""#.to_owned();
        let mut base = format!("\"@method\": {method}\n\"@target-uri\": {uri}\n");
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/{path}"))
            .header(header::HOST, host);
        if !body.is_empty() {
            let digest = format!("sha-256=:{}:", BASE64.encode(Sha256::digest(body)));
            components.push_str(r#" "content-digest""#);
            base.push_str(&format!("\"content-digest\": {digest}\n"));
            builder = builder.header("content-digest", digest);
        }
        let params = format!(
            r#"({components});created={created};nonce="{nonce}";keyid="{keyid}";alg="hmac-sha256""#
        );
        base.push_str(&format!("\"@signature-params\": {params}"));
        let mut hmac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
        hmac.update(base.as_bytes());
        let mac = BASE64.encode(hmac.finalize().into_bytes());
        builder
            .header("signature-input", format!("sig={params}"))
            .header("signature", format!("sig=:{mac}:"))
            .body(Body::from(body.to_vec()))
            .unwrap()
    }

    const NOW: i64 = 1_700_000_000;
    const URI: &str = "https://relay.example.com/me";

    fn verifier() -> Verifier {
        let alice = Tunnel {
            name: "alice".to_owned(),
            token: Secret::new("alice-token"),
        };
        Verifier::new(
            Arc::new(ServedTunnels::new(&[alice])),
            Some(Secret::new("admin-key")),
        )
    }

    /// Stop serving the tunnel `name`, as the registry does on a delete.
    fn remove(verifier: &Verifier, name: &str) {
        verifier.tunnels.remove(name);
        verifier.forget(name);
    }

    async fn verify_at(
        verifier: &Verifier,
        request: Request<Body>,
        now: i64,
    ) -> Result<SignedBy, &'static str> {
        let (parts, body) = request.into_parts();
        let body = axum::body::to_bytes(body, MAX_BODY_BYTES).await.unwrap();
        verifier.verify(&parts, &body, now)
    }

    async fn verify(verifier: &Verifier, request: Request<Body>) -> Result<SignedBy, &'static str> {
        verify_at(verifier, request, NOW).await
    }

    /// RFC 9421 Appendix B.2.5: the `hmac-sha256` example over the
    /// Appendix B.2 request, with the shared secret from Appendix B.1.5.
    #[test]
    fn rfc_9421_b_2_5_test_vector_verifies() {
        let request = Request::builder()
            .method("POST")
            .uri("/foo?param=Value&Pet=dog")
            .header("host", "example.com")
            .header("date", "Tue, 20 Apr 2021 02:07:55 GMT")
            .header("content-type", "application/json")
            .header(
                "content-digest",
                "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
            )
            .header("content-length", "18")
            .header(
                "signature-input",
                r#"sig-b25=("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret""#,
            )
            .header(
                "signature",
                "sig-b25=:pxcQw6G3AjtMBQjwo8XzkZf/bws5LelbaMk5rGIGtE8=:",
            )
            .body(())
            .unwrap();
        let (parts, ()) = request.into_parts();
        let key = BASE64
            .decode(
                "uzvJfB4u3N0Jy4T7NZ75MDVcr8zSTInedJtkgcu46YW4XByzNJjxBdtjUkdJPBtbmHhIDi6pcl8jsasjlTMtDQ==",
            )
            .unwrap();

        let signature = ReceivedSignature::from_headers(&parts.headers).unwrap();
        let base = signature_base(&parts, &signature.input).unwrap();
        assert_eq!(
            base,
            "\"date\": Tue, 20 Apr 2021 02:07:55 GMT\n\
             \"@authority\": example.com\n\
             \"content-type\": application/json\n\
             \"@signature-params\": (\"date\" \"@authority\" \"content-type\");created=1618884473;keyid=\"test-shared-secret\""
        );
        assert_eq!(mac_is_valid(&key, &base, &signature.mac), Ok(true));
        assert_eq!(
            mac_is_valid(b"another key", &base, &signature.mac),
            Ok(false)
        );
    }

    /// A request the admin UI's signer (`relay-core`, in TypeScript) signed:
    /// `slices/relay/relay-core/src/signing/fixtures/admin-request.json`,
    /// which relay-core's own test checks it still produces. It verifies
    /// here as the admin, at the time it was signed.
    #[tokio::test]
    async fn admin_request_fixture_from_the_js_signer_verifies() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../slices/relay/relay-core/src/signing/fixtures/admin-request.json"
        )))
        .unwrap();
        let text = |name: &str| fixture[name].as_str().unwrap();
        let (host, path) = text("url")
            .strip_prefix("https://")
            .and_then(|rest| rest.split_once('/'))
            .unwrap();
        let mut builder = Request::builder()
            .method(text("method"))
            .uri(format!("/{path}"))
            .header(header::HOST, host);
        for (name, value) in fixture["headers"].as_object().unwrap() {
            builder = builder.header(name.as_str(), value.as_str().unwrap());
        }
        let request = builder.body(Body::from(text("body").to_owned())).unwrap();
        let verifier = Verifier::new(Arc::default(), Some(Secret::new(text("key"))));

        let created = fixture["created"].as_i64().unwrap();
        assert_eq!(
            verify_at(&verifier, request, created).await,
            Ok(SignedBy::Admin)
        );
    }

    #[tokio::test]
    async fn accepts_tunnel_and_admin_signatures() {
        let verifier = verifier();
        let request = signed_request("GET", URI, b"", "alice", "alice-token", NOW, "n1");
        assert_eq!(
            verify(&verifier, request).await,
            Ok(SignedBy::Tunnel(TunnelName::parse("alice").unwrap()))
        );
        let request = signed_request("POST", URI, b"{}", "admin", "admin-key", NOW, "n2");
        assert_eq!(verify(&verifier, request).await, Ok(SignedBy::Admin));
    }

    #[tokio::test]
    async fn rejects_wrong_key_and_unknown_keyid() {
        let verifier = verifier();
        for (keyid, key) in [("alice", "admin-key"), ("bob", "alice-token")] {
            let request = signed_request("GET", URI, b"", keyid, key, NOW, "n");
            assert!(verify(&verifier, request).await.is_err(), "{keyid}");
        }
        // Without an admin key, `admin` signs nothing.
        let no_admin = Verifier::new(Arc::default(), None);
        let request = signed_request("GET", URI, b"", "admin", "", NOW, "n");
        assert!(verify(&no_admin, request).await.is_err());
    }

    #[tokio::test]
    async fn rejects_stale_or_future_created() {
        let verifier = verifier();
        for created in [NOW - CLOCK_SKEW_SECS - 1, NOW + CLOCK_SKEW_SECS + 1] {
            let request = signed_request("GET", URI, b"", "alice", "alice-token", created, "n");
            assert!(verify(&verifier, request).await.is_err(), "{created}");
        }
        for created in [NOW - CLOCK_SKEW_SECS, NOW + CLOCK_SKEW_SECS] {
            let nonce = format!("n{created}");
            let request = signed_request("GET", URI, b"", "alice", "alice-token", created, &nonce);
            assert!(verify(&verifier, request).await.is_ok(), "{created}");
        }
    }

    #[tokio::test]
    async fn rejects_a_replayed_nonce_within_the_window() {
        let verifier = verifier();
        let request = || signed_request("GET", URI, b"", "alice", "alice-token", NOW, "once");
        assert!(verify(&verifier, request()).await.is_ok());
        assert_eq!(verify(&verifier, request()).await, Err("replayed nonce"));
        // A rejected request does not burn its nonce.
        let forged = signed_request("GET", URI, b"", "alice", "wrong", NOW, "fresh");
        assert!(verify(&verifier, forged).await.is_err());
        let request = signed_request("GET", URI, b"", "alice", "alice-token", NOW, "fresh");
        assert!(verify(&verifier, request).await.is_ok());
    }

    #[test]
    fn each_keys_nonce_set_is_bounded_and_drops_expired_nonces_when_full() {
        let verifier = verifier();
        let alice = Secret::new("alice-token");
        for i in 0..MAX_NONCES_PER_KEY {
            verifier
                .remember_nonce("alice", &alice, &i.to_string(), NOW + CLOCK_SKEW_SECS, NOW)
                .unwrap();
        }
        assert_eq!(
            verifier.remember_nonce("alice", &alice, "one more", NOW + CLOCK_SKEW_SECS, NOW),
            Err("nonce set is full")
        );
        // One signer filling its set does not lock out another, and nonces
        // are per key.
        verifier
            .remember_nonce(
                "admin",
                &Secret::new("admin-key"),
                "0",
                NOW + CLOCK_SKEW_SECS,
                NOW,
            )
            .unwrap();
        let later = NOW + CLOCK_SKEW_SECS + 1;
        verifier
            .remember_nonce("alice", &alice, "one more", later + CLOCK_SKEW_SECS, later)
            .unwrap();
        assert_eq!(verifier.nonces.lock().unwrap()["alice"].len(), 1);
    }

    #[tokio::test]
    async fn served_tunnels_change_the_signers_and_forgetting_keeps_the_others_nonces() {
        let verifier = verifier();
        for (keyid, key, nonce) in [("alice", "alice-token", "a1"), ("admin", "admin-key", "m1")] {
            let request = signed_request("GET", URI, b"", keyid, key, NOW, nonce);
            assert!(verify(&verifier, request).await.is_ok(), "{keyid}");
        }

        verifier.tunnels.insert(&Tunnel {
            name: "bob".to_owned(),
            token: Secret::new("bob-token"),
        });
        let bob = signed_request("GET", URI, b"", "bob", "bob-token", NOW, "b1");
        assert_eq!(
            verify(&verifier, bob).await,
            Ok(SignedBy::Tunnel(TunnelName::parse("bob").unwrap()))
        );
        remove(&verifier, "alice");
        let alice = signed_request("GET", URI, b"", "alice", "alice-token", NOW, "a2");
        assert_eq!(verify(&verifier, alice).await, Err("unknown keyid"));
        // The remaining signers keep their nonce sets.
        for (keyid, key, nonce) in [("admin", "admin-key", "m1"), ("bob", "bob-token", "b1")] {
            let replayed = signed_request("GET", URI, b"", keyid, key, NOW, nonce);
            assert_eq!(verify(&verifier, replayed).await, Err("replayed nonce"));
        }
        let nonces = verifier.nonces.lock().unwrap();
        assert!(
            !nonces.contains_key("alice"),
            "a removed tunnel's nonces go"
        );
        assert!(nonces.contains_key("admin"));
    }

    /// A request checked against the old keys cannot record a nonce for a
    /// signer removed before it got that far.
    #[test]
    fn a_removed_signer_records_no_nonce() {
        let verifier = verifier();
        let alice = Secret::new("alice-token");
        remove(&verifier, "alice");
        assert_eq!(
            verifier.remember_nonce("alice", &alice, "n", NOW + CLOCK_SKEW_SECS, NOW),
            Err("unknown keyid")
        );
        assert!(verifier.nonces.lock().unwrap().is_empty());
    }

    /// Nor can it for a signer deleted and created again under the same
    /// name with a new key: the old key no longer signs as that name.
    #[test]
    fn a_signer_created_again_under_the_same_name_records_no_nonce_for_the_old_key() {
        let verifier = verifier();
        remove(&verifier, "alice");
        verifier.tunnels.insert(&Tunnel {
            name: "alice".to_owned(),
            token: Secret::new("alice-new-token"),
        });
        assert_eq!(
            verifier.remember_nonce(
                "alice",
                &Secret::new("alice-token"),
                "n",
                NOW + CLOCK_SKEW_SECS,
                NOW
            ),
            Err("unknown keyid")
        );
        verifier
            .remember_nonce(
                "alice",
                &Secret::new("alice-new-token"),
                "n",
                NOW + CLOCK_SKEW_SECS,
                NOW,
            )
            .unwrap();
    }

    #[tokio::test]
    async fn rejects_a_body_that_does_not_match_its_digest() {
        let verifier = verifier();
        let request = signed_request("POST", URI, b"{\"a\":1}", "alice", "alice-token", NOW, "n");
        let (parts, _) = request.into_parts();
        let tampered = Request::from_parts(parts, Body::from("{\"a\":2}"));
        assert_eq!(
            verify(&verifier, tampered).await,
            Err("content-digest does not match the body")
        );
    }

    #[tokio::test]
    async fn rejects_a_body_without_a_covered_digest() {
        let verifier = verifier();
        let request = signed_request("POST", URI, b"", "alice", "alice-token", NOW, "n");
        let (parts, _) = request.into_parts();
        let with_body = Request::from_parts(parts, Body::from("smuggled"));
        assert!(verify(&verifier, with_body).await.is_err());
    }

    #[tokio::test]
    async fn rejects_a_tampered_method_or_target_uri() {
        let verifier = verifier();
        let tamperings: [fn(&mut Parts); 4] = [
            |parts| parts.method = axum::http::Method::DELETE,
            |parts| parts.uri = "/me?x=1".parse().unwrap(),
            |parts| parts.uri = "/other".parse().unwrap(),
            |parts| {
                parts
                    .headers
                    .insert(header::HOST, "evil.example.com".parse().unwrap());
            },
        ];
        for (i, tamper) in tamperings.into_iter().enumerate() {
            let request = signed_request("GET", URI, b"", "alice", "alice-token", NOW, "n");
            let (mut parts, body) = request.into_parts();
            tamper(&mut parts);
            let result = verify(&verifier, Request::from_parts(parts, body)).await;
            assert_eq!(result, Err("MAC mismatch"), "tampering {i}");
        }
    }

    /// The `Host` is normalized the way a URL parser serializes a URL, so the
    /// client signs the URL it fetches.
    #[tokio::test]
    async fn host_is_lowercased_and_drops_the_default_port() {
        let verifier = verifier();
        for host in ["Relay.Example.com", "relay.example.com:443"] {
            let request = signed_request("GET", URI, b"", "alice", "alice-token", NOW, host);
            let (mut parts, body) = request.into_parts();
            parts.headers.insert(header::HOST, host.parse().unwrap());
            let result = verify(&verifier, Request::from_parts(parts, body)).await;
            assert!(result.is_ok(), "{host}");
        }
    }

    /// Each required parameter and component, removed or changed in an
    /// otherwise valid signature input, is rejected; so are components the
    /// relay does not derive or supports no parameters for, and an
    /// `expires` in the past.
    #[tokio::test]
    async fn rejects_missing_parameters_and_components() {
        let verifier = verifier();
        let full = r#"("@method" "@target-uri");created=1700000000;nonce="n";keyid="alice";alg="hmac-sha256""#;
        let without = [
            full.replace(";created=1700000000", ""),
            full.replace(";nonce=\"n\"", ""),
            full.replace(";keyid=\"alice\"", ""),
            full.replace(";alg=\"hmac-sha256\"", ""),
            full.replace("alg=\"hmac-sha256\"", "alg=\"hmac-sha512\""),
            full.replace("nonce=\"n\"", "nonce=\"\""),
            full.replace("(\"@method\" \"@target-uri\")", "(\"@target-uri\")"),
            full.replace("(\"@method\" \"@target-uri\")", "(\"@method\")"),
            full.replace("\"@target-uri\")", "\"@target-uri\" \"@method\")"),
            full.replace("\"@target-uri\")", "\"@target-uri\" \"@path\")"),
            full.replace("\"@target-uri\")", "\"@target-uri\" \"x-absent\")"),
            full.replace("\"@target-uri\")", "\"@target-uri\" \"host\";sf)"),
            full.replace(";alg", ";expires=1699999999;alg"),
        ];
        for params in without {
            let request = signed_with_input(&params, "alice-token");
            assert!(verify(&verifier, request).await.is_err(), "{params}");
        }
        assert!(verify(&verifier, signed_with_input(full, "alice-token"))
            .await
            .is_ok());
    }

    /// `GET /me` signed over exactly `params`, whatever they say.
    fn signed_with_input(params: &str, key: &str) -> Request<Body> {
        let input: Dictionary = Parser::new(&format!("sig={params}")).parse().unwrap();
        let Some(ListEntry::InnerList(inner)) = input.get("sig") else {
            panic!("inner list");
        };
        let mut base = String::new();
        for item in &inner.items {
            let name = item.bare_item.as_string().unwrap().as_str();
            let value = match name {
                "@method" => "GET",
                "@target-uri" => URI,
                "host" => "relay.example.com",
                _ => "",
            };
            base.push_str(&format!("\"{name}\": {value}\n"));
        }
        base.push_str(&format!("\"@signature-params\": {params}"));
        let mut hmac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
        hmac.update(base.as_bytes());
        let mac = BASE64.encode(hmac.finalize().into_bytes());
        Request::builder()
            .uri("/me")
            .header(header::HOST, "relay.example.com")
            .header("signature-input", format!("sig={params}"))
            .header("signature", format!("sig=:{mac}:"))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn rejects_missing_or_mismatched_signature_headers() {
        let verifier = verifier();
        let request = signed_request("GET", URI, b"", "alice", "alice-token", NOW, "n");
        let (parts, _) = request.into_parts();
        let edits: [fn(&mut HeaderMap); 5] = [
            |headers| {
                headers.remove("signature");
            },
            |headers| {
                headers.remove("signature-input");
            },
            |headers| {
                let sig = headers["signature"]
                    .to_str()
                    .unwrap()
                    .replacen("sig=", "other=", 1);
                headers.insert("signature", sig.parse().unwrap());
            },
            |headers| {
                let sig = headers["signature"].to_str().unwrap().to_owned();
                headers.append(
                    "signature",
                    sig.replacen("sig=", "second=", 1).parse().unwrap(),
                );
            },
            |headers| {
                let input = headers["signature-input"].to_str().unwrap().to_owned();
                headers.append(
                    "signature-input",
                    input.replacen("sig=", "second=", 1).parse().unwrap(),
                );
            },
        ];
        for (i, edit) in edits.into_iter().enumerate() {
            let mut parts = parts.clone();
            edit(&mut parts.headers);
            let result = verify(&verifier, Request::from_parts(parts, Body::empty())).await;
            assert!(result.is_err(), "edit {i}");
        }
    }
}
