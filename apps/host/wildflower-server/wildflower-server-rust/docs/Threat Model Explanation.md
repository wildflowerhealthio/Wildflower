# Threat Model Explanation

What the Wildflower server, the process that composes every server slice
behind one tunnel listener, enforces at its edge. The general model is the
[Threat Model Explanation](../../../../../docs/Security/Threat%20Model%20Explanation.md);
the listener and the origin are the
[Origins Explanation](../../../../../docs/Origins/Explanation.md), assumed
here.

## The edge, from the outside in

1. **The tunnel.** `tunnel-rust` dials the relay as a rathole client over
   Noise NK to the relay's pinned key, authenticated by the tunnel token,
   and hands each visitor's stream over in process. It stops dialing when the
   relay refuses the token or no longer knows the tunnel.
2. **PROXY v2.** The visitor's address, from the relay, becomes the
   connection's `TunnelVisitor`. No header can set it.
3. **TLS.** Terminated here, with the certificate ordered from Let's Encrypt
   over TLS-ALPN-01 and served only to a ClientHello naming the server's
   domain. 5 s handshake timeout, at most 64 handshakes in flight.
4. **The tunnel front.** Every host the request names must be the server's
   domain, as an `https` origin, or the answer is `421`; `Forwarded` and
   `X-Forwarded-*` are dropped. Outside every layer but CORS.
5. **The cookie-to-bearer layer.** `__Host-browser_session` and `hfs_session`
   become `Authorization: Bearer` only when the request's `Origin` is the
   server's own; a write with a cookie and a foreign origin is `403`.
6. **The bearer gate** (`require_valid_bearer_token`) in front of FHIR, apps,
   databases, request log and OHIF; the authorization server gates its own
   routes. Discovery documents are the only unauthenticated paths.
7. **Per-slice capabilities**, scope by scope.

Nothing is reached any other way. There is no loopback listener, so a
process on the same machine is a visitor like any other.

## What this crate owns

- **The public origin**, built once from the record's domain and handed to
  every slice; `iss`, `aud`, HFS's `base_url`, launch URLs and redirects all
  read it from config, never from the request.
- **The certificate order and renewal**, the TLS key under
  `certificates/` (0700), renewal at one third of lifetime left, no revocation.
- **The authorization start limit**: 10 then 1 per 30 s per visitor address
  (IPv4, or IPv6 /64), 30 then 1 per 10 s globally, 1024 visitors tracked. A
  request with no `TunnelVisitor` is admitted, which only in-process and test
  callers are.
- **The request log**: route, status, size, duration, client id and the
  visitor's address, no ids or query, 30 days and row caps.
- **The database endpoints**: `GET /databases/{id}` returns a full snapshot;
  `health-data.sqlite` needs `system/*.rs`, `wildflower.sqlite` needs
  `wildflower/*.r`, deletes need the matching `.d`.
- **Reachability**: the server checks itself at its public origin, through
  the relay, so "reachable" means the whole path works.

## Threats

| Threat                                        | Outcome                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged `Host`, `Forwarded`, visitor address   | `421`, dropped, or ignored: the front compares against config and the address is a typed extension.                                                |
| Token from another Wildflower server          | Refused: `iss` and `aud` name that server's origin.                                                                                                |
| Cross-site write with the cookie              | `403` on `Origin`; `SameSite=Lax` alone is not enough because relay tunnels are same-site with each other.                                         |
| TLS exhaustion through the tunnel             | 64 handshakes in flight, 5 s timeout; the tunnel itself can still be kept busy.                                                                    |
| Relay impersonating the device's TLS          | Needs a certificate for the hostname: see the [Relay Threat Model](../../../../relay/docs/Threat%20Model%20Explanation.md).                        |
| `wildflower.sqlite` downloaded                | The signing key leaves with it: see the [Authorization Server Threat Model](../../authorization-server-rust/docs/Threat%20Model%20Explanation.md). |
| Address-based rate limit behind stock rathole | No PROXY header, so every visitor shares one bucket and a visitor can write its own header: wildflower-relay only.                                 |
| HFS vulnerability                             | Reached only after the bearer gate, with a verified token; HFS re-verifies. HFS's own code is unaudited here.                                      |

## See also

- [Host Threat Model](../../../host-app/Threat%20Model%20Explanation.md):
  the files this server writes and who can read them on the device.
- [Server Runs Explanation](../../../servers/docs/Server%20Runs%20Explanation.md):
  when the process runs at all.
