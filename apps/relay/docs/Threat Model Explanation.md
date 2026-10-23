# Threat Model Explanation

What wildflower-relay is trusted with and what can go wrong there. The
general model is the [Threat Model Explanation](../../../docs/Security/Threat%20Model%20Explanation.md);
what the operator can and can't see is the
[Relay Explanation](../../../docs/Relay/Explanation.md), which this doc
assumes.

## Assets on the relay

- **`tunnels.db`**: each tunnel's name, owner email and token, the token in
  plaintext because rathole and request signing both key on it. Mode 0600 in
  a 0700 state directory. Claim codes and access codes are stored as SHA-256
  only.
- **The noise private key** (`WILDFLOWER_RELAY_NOISE_PRIVATE_KEY`): devices pin
  its public half. Whoever holds it can stand up a relay devices will trust.
- **The admin key** (`WILDFLOWER_RELAY_ADMIN_KEY`): creates, deletes and
  re-tokens tunnels and issues claim codes and access codes.
- **The relay's own certificate and ACME account**, for `<domain>` and
  `admin.<domain>` only. The relay holds no key for any tunnel's hostname.
- **DNS for the relay's domain**, held by the operator outside the relay.

## Entry points

| Port / path                    | Who          | Authentication                                                                                              |
| ------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `:443`, SNI = a tunnel         | Any visitor  | None at the relay; TLS is the device's. Unknown or offline tunnels are closed without a byte.               |
| `:443`, SNI = `<domain>`       | Devices      | `GET /rathole` is public; `POST /claim` and `POST /access` take a code; `GET /me` is signed with the token. |
| `:443`, SNI = `admin.<domain>` | The operator | RFC 9421 HMAC-SHA256 signature with the admin key, ±60 s clock window, nonce cache. No sessions.            |
| `:80`                          | Any visitor  | Redirect or 404 only; nothing is proxied in plaintext.                                                      |
| rathole control port           | Devices      | Noise NK to the relay's key; the device proves itself with its tunnel token.                                |

## What the relay enforces

- **SNI-only routing.** The TLS front reads the ClientHello, resolves the
  name, writes a PROXY v2 header with the visitor's address and copies bytes.
  A local hostname always wins over a tunnel of the same name; `admin` is
  reserved.
- **Claim codes.** 8 characters, one outstanding per tunnel, ten days by
  default, single use, hashed at rest. Every failure answers the same `422`.
  `POST /claim` is limited per client address (5, then 1 per 12 s) and
  globally (60, then 1 per s), before the body is parsed: ten days at the global
  rate is under a million guesses against 31⁸ (about 8.5 × 10¹¹) codes.
- **Access codes.** A claim code's format, lifetime and hashing, but no
  tunnel: whoever holds one creates a tunnel, under an email and subdomain
  they choose, so an outstanding access code is a standing invitation, and
  the operator issues one only for someone they would create a tunnel for.
  A code's hash is never stored as both kinds. A failed code is one `422`
  whatever came with it; only a code that redeems learns whether its email
  and subdomain are acceptable, and stays unspent until they are. `POST
  /access` spends from `POST /claim`'s limits, so guessing either kind of
  code shares one budget.
- **Signed requests.** The token is never sent; the signature covers method,
  target URI and body digest. Verification is constant-time and every failure
  is a bare `401`.
- **Re-tokening and deletion take effect at once**: the old control channel is
  dropped.
- **Process limits.** At most 4096 concurrent front connections, a 5 s hello
  timeout, a DynamicUser that can bind only 80 and 443, and a sudoers file
  that limits the deploy user.

## What the relay does not enforce

- **Who owns a hostname.** A device "owns" `<tunnel name>.<domain>` only by
  holding the tunnel's token, and proves it to Let's Encrypt by answering
  TLS-ALPN-01 through the tunnel. There is no second proof.
- **Admin brute force.** Signature attempts are not rate-limited; the 32-byte
  minimum key length is the protection.
- **Name retirement.** A deleted tunnel's name is free to create again.
- **Visitor identity.** The relay writes the address it accepted the
  connection from into the PROXY header; the device trusts it only as far as
  it trusts the operator.

## Threats

| Threat                                    | Outcome                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passive operator or network tap           | Sees SNI, addresses, timing, volume, device uptime. No plaintext.                                                                                                               |
| Operator with DNS and port 443            | Can get a certificate for a tunnel's hostname and interpose. Logged in CT; the device does not watch CT yet (#898). CAA narrows to TLS-ALPN-01.                                 |
| Stolen `tunnels.db` or admin key          | Impersonate any device's tunnel to rathole. Visitors' TLS still fails without the device's certificate. Re-token every tunnel.                                                  |
| Stolen noise key                          | A rogue relay devices accept. Rotate the key; every device must re-pin.                                                                                                         |
| Compromised `main` or `relay` environment | Controls the binary and its secrets on the next push. Equivalent to the operator.                                                                                               |
| Claim-code guessing                       | 31^8 space, rate-limited, 15-minute window, one code per tunnel.                                                                                                                |
| Flooding                                  | Connection cap and hello timeout protect the process; a device's tunnel can still be kept busy.                                                                                 |
| Stock rathole instead of wildflower-relay | No PROXY header, so a visitor can forge its address; the device grants nothing on it ([Stock Rathole Server How-To](../../../docs/Relay/Stock%20Rathole%20Server%20How-To.md)). |

## Logging

The relay keeps no request log, and logs nothing of a connection that
reaches a device. At info it logs tunnels going up and down by name, tunnel
creation, deletion and re-tokening, claim codes issued and redeemed, and
every refused `:443` connection, with the visitor's address, how long the
connection lasted, and what it sent: the tunnel or server name it asked
for; for a ClientHello without a server name, the IP address it sent in
place of one and the first four protocols it offered (ALPN), each cut to 16
bytes; how many bytes arrived before the hello deadline; or the first 32
bytes it sent if they were not a ClientHello. Claim rate-limit refusals log the client's address at
debug, and the rathole library logs the address each control channel comes
from. All of these go to the connection log, which the relay deletes after
24 hours; the journal names no tunnel or address.

## See also

- [Deploying How-To](./Deploying%20How-To.md): the DNS, CAA and secrets this
  model assumes.
- `relay-server/src/lib.rs`: the crate docs are the spec for routing, signing
  and the admin API.
