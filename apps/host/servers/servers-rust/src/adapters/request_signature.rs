//! Signing a request to the relay's site as a tunnel: HTTP Message
//! Signatures (RFC 9421), `alg="hmac-sha256"`, keyed by the tunnel's token,
//! with the tunnel name as `keyid`. The token never leaves the device; the
//! relay checks the MAC with its own copy.
//!
//! Only bodiless requests are signed, so the covered components are always
//! `"@method"` and `"@target-uri"`, and no `Content-Digest` is sent. The
//! relay's `site::signature` module has the rules it verifies against.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use url::Url;
use wildflowerhealthio_rathole_settings::TunnelName;

use crate::domain::TunnelToken;

/// The label the one signature goes under in both headers.
const LABEL: &str = "sig";

/// The `Signature-Input` and `Signature` header values for one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RequestSignature {
    pub(crate) signature_input: String,
    pub(crate) signature: String,
}

impl RequestSignature {
    /// Sign `method` `target_uri` as `tunnel_name` with `token` at unix time
    /// `created`, under `nonce`. The target URI is the URL fetched, as [`Url`]
    /// serialises it: lowercase host and no default port, which is how the
    /// relay rebuilds it from the request.
    ///
    /// `nonce` must be a structured-field string's content (printable ASCII
    /// without `"` or `\`), and the relay accepts each once.
    pub(crate) fn sign(
        method: &str,
        target_uri: &Url,
        tunnel_name: &TunnelName,
        token: &TunnelToken,
        created: i64,
        nonce: &str,
    ) -> Self {
        let signature_params = format!(
            r#"("@method" "@target-uri");created={created};nonce="{nonce}";keyid="{tunnel_name}";alg="hmac-sha256""#
        );
        let base = signature_base(method, target_uri, &signature_params);
        let mut hmac = Hmac::<Sha256>::new_from_slice(token.expose().as_bytes())
            .expect("HMAC takes a key of any length");
        hmac.update(base.as_bytes());
        let mac = BASE64.encode(hmac.finalize().into_bytes());
        Self {
            signature_input: format!("{LABEL}={signature_params}"),
            signature: format!("{LABEL}=:{mac}:"),
        }
    }
}

/// The signature base (RFC 9421 §2.5): a line per covered component, then
/// `"@signature-params"`, joined with `\n` and no trailing newline.
fn signature_base(method: &str, target_uri: &Url, signature_params: &str) -> String {
    format!(
        "\"@method\": {method}\n\"@target-uri\": {target_uri}\n\"@signature-params\": {signature_params}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked example in `wildflower-relay`'s crate docs.
    #[test]
    fn the_signature_base_is_the_relay_s_documented_example() {
        let target_uri = Url::parse("https://relay.example.com/me").unwrap();
        assert_eq!(
            signature_base(
                "GET",
                &target_uri,
                r#"("@method" "@target-uri");created=1700000000;nonce="<random>";keyid="alice";alg="hmac-sha256""#
            ),
            "\"@method\": GET\n\
             \"@target-uri\": https://relay.example.com/me\n\
             \"@signature-params\": (\"@method\" \"@target-uri\");created=1700000000;nonce=\"<random>\";keyid=\"alice\";alg=\"hmac-sha256\""
        );
    }

    #[test]
    fn the_headers_carry_the_parameters_and_never_the_token() {
        let token = TunnelToken::new("s3cret-tunnel-token");
        let signature = RequestSignature::sign(
            "GET",
            &Url::parse("https://relay.example.com/me").unwrap(),
            &TunnelName::parse("alice").unwrap(),
            &token,
            1_700_000_000,
            "n0nce",
        );
        assert_eq!(
            signature.signature_input,
            r#"sig=("@method" "@target-uri");created=1700000000;nonce="n0nce";keyid="alice";alg="hmac-sha256""#
        );
        assert!(signature.signature.starts_with("sig=:"));
        assert!(signature.signature.ends_with(':'));
        for header in [&signature.signature_input, &signature.signature] {
            assert!(!header.contains(token.expose()), "{header}");
        }
    }

    #[test]
    fn the_mac_depends_on_the_token_and_every_signed_part() {
        let sign = |method: &str, uri: &str, tunnel_name: &str, token: &str, created, nonce| {
            RequestSignature::sign(
                method,
                &Url::parse(uri).unwrap(),
                &TunnelName::parse(tunnel_name).unwrap(),
                &TunnelToken::new(token),
                created,
                nonce,
            )
            .signature
        };
        let original = sign("GET", "https://relay.example.com/me", "alice", "t", 1, "n");
        for changed in [
            sign("POST", "https://relay.example.com/me", "alice", "t", 1, "n"),
            sign(
                "GET",
                "https://relay.example.com/rathole",
                "alice",
                "t",
                1,
                "n",
            ),
            sign("GET", "https://relay.example.com/me", "bob", "t", 1, "n"),
            sign("GET", "https://relay.example.com/me", "alice", "u", 1, "n"),
            sign("GET", "https://relay.example.com/me", "alice", "t", 2, "n"),
            sign("GET", "https://relay.example.com/me", "alice", "t", 1, "m"),
        ] {
            assert_ne!(changed, original);
        }
    }
}
