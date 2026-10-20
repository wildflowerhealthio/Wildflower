# Threat Model Explanation

What Wildflower protects, from whom, with what, and what it leaves undefended.
This is the top of the tree: each component has its own threat model with
the specifics, and this doc links rather than restates.

- [Relay Threat Model](../../apps/relay/docs/Threat%20Model%20Explanation.md)
- [Host Threat Model](../../apps/host/host-app/Threat%20Model%20Explanation.md)
- [Authorization Server Threat Model](../../apps/host/wildflower-server/authorization-server-rust/docs/Threat%20Model%20Explanation.md)
- [Wildflower Server Threat Model](../../apps/host/wildflower-server/wildflower-server-rust/docs/Threat%20Model%20Explanation.md)

## The system in one paragraph

The Wildflower host app runs a personal FHIR server on the Owner's own phone
or laptop. The server has no port: it is reached only at `https://<tunnel
name>.<relay domain>`, through a tunnel the device keeps open to a relay, and
TLS terminates on the device with a certificate the device ordered from Let's
Encrypt ([Origins Explanation](../Origins/Explanation.md)). Web apps hosted
at `*.wildflowerhealth.io` (the launcher, Wildflower Authorization and the
SMART apps) are OAuth clients of that server. There are no accounts and no
passwords: the Owner is whoever holds the device, and the host app signs
browsers in as the Owner with one-time codes.

## Assets

In order of how bad losing them is:

1. **Health records**: `health-data.sqlite` and its bulk exports, on the
   device.
2. **The Owner's authority**: a same-device browser session (8 hours of
   `OWNER_SCOPES`), a same-device sign-in code (60 seconds), or any bearer
   holding the approval scopes. Whoever holds one can read and change every
   record and approve new apps.
3. **The authorization database**: `wildflower.sqlite` holds the RSA signing
   key in plaintext, standing grants, refresh-token hashes and browser
   sessions. The signing key mints Owner-equivalent tokens.
4. **The device's TLS private key and ACME account key**: with the TLS key
   and a path to the visitor's traffic, the relay's end-to-end guarantee is
   gone.
5. **The tunnel token**: lets anyone stand in for the device at the relay,
   though without a certificate visitors' TLS still fails.
6. **Metadata**: the tunnel name (public, in CT logs), the request log's
   visitor addresses, the relay's email per tunnel, telemetry.

## Parties

| Party                                     | Trusted with                                                                                      | Not trusted with                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| The Owner and their device                | Everything. The device is the trust anchor.                                                       |                                                                       |
| The relay operator                        | Availability, routing metadata, visitor addresses, when the device is online, the tunnel token.   | Plaintext. TLS ends on the device.                                    |
| Let's Encrypt and the CT logs             | That `<tunnel name>.<relay domain>` exists and when its certificates were issued.                 | Anything else.                                                        |
| GitHub Pages and whoever can push to main | The code of every hosted app, the relay binary and its deploy secrets, and the host app's builds. | Records: the hosted apps run in the Owner's browser, not on a server. |
| Sentry                                    | Crash reports and performance data, only after the Owner opts in, each app separately.            | Anything the Owner has not switched on.                               |
| A SMART app the Owner approves            | Exactly the scopes the Owner ticked, on this server, at the redirect it was approved for.         | Other scopes, other servers.                                          |
| Anyone on the internet                    | Nothing. The server's address is public; every request needs a bearer or a same-origin cookie.    |                                                                       |

## Trust boundaries

| Boundary                         | What crosses it                           | What enforces it                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Visitor ↔ relay                  | TLS ClientHello, ciphertext               | The relay reads only the SNI and passes bytes through ([Relay Explanation](../Relay/Explanation.md)).                                                                                                        |
| Relay ↔ device                   | The tunnel's control and data channels    | Noise NK to the relay's pinned public key; the device authenticates with its tunnel token.                                                                                                                   |
| Device TLS ↔ the server's router | Decrypted HTTP                            | The tunnel front: the request must name the server's domain, forwarding headers are dropped, the visitor's address is a typed extension ([Origins Explanation](../Origins/Explanation.md#the-tunnel-front)). |
| Unauthenticated ↔ authenticated  | Bearer tokens, the browser-session cookie | One `TokenVerifier` behind every gate; a cookie becomes a bearer only from the server's own origin ([Scope-Gated Endpoints Explanation](../Authorization/Scope-Gated%20Endpoints%20Explanation.md)).         |
| Authenticated ↔ data             | A capability per scope                    | `Scoped<F>`: a handler reaches a store only through a capability whose construction is the scope check.                                                                                                      |
| The Owner ↔ an app               | A consent decision                        | The consent card and device page; grants clamped to what was requested and to what the approver holds ([Jargon Explanation](../../slices/authorization/docs/Jargon%20Explanation.md#approval-scopes)).       |
| The host app's webview ↔ Rust    | Tauri commands                            | Capabilities per webview label; remote content in the native webview gets listen and one allowlisted emit ([Host Threat Model](../../apps/host/host-app/Threat%20Model%20Explanation.md)).                   |
| The device ↔ Sentry              | Events, after consent                     | A default-deny transport allowlist and URL, host and element scrubbing ([Telemetry Explanation](../../slices/telemetry/docs/Telemetry%20Explanation.md)).                                                    |

## What Wildflower defends against

- **A relay operator reading traffic.** TLS ends on the device; the relay
  never holds a key for a tunnel's hostname. A passive operator sees SNI,
  addresses, timing and volume.
- **A visitor forging where a request came from.** The tunnel front drops
  `Forwarded` and `X-Forwarded-*` and takes the visitor's address only from
  the relay's PROXY header.
- **A request for the wrong server.** `iss` and `aud` are the server's own
  origin and are checked against configuration, never the request. A token
  minted by another Wildflower server is refused by construction.
- **Stolen or replayed tokens.** Access tokens live 15 minutes; refresh
  tokens rotate in families and a replay revokes the family; authorization
  codes are single-use, 60 seconds, bound to PKCE S256, client and redirect.
- **Cross-site requests riding the browser-session cookie.** A write with the
  cookie must carry the server's own `Origin`; CORS never allows credentials.
- **An app widening its own access.** Code-flow consent is clamped to the
  request, and the approver cannot delegate a scope it does not hold.
- **An unknown app impersonating a trusted one.** Trust on first use shows the
  redirect origin and requires an explicit acknowledgment; errors on an
  untrusted redirect render locally rather than redirecting.
- **Flooding the Owner with consent prompts.** Authorization starts are
  rate-limited per visitor address and globally.
- **Telemetry carrying records by accident.** Nothing initializes before
  consent; URLs, hosts and element selectors are reduced to shapes; replays,
  profiles and logs are never sent.

## What Wildflower does not defend against

- **A compromised device.** Everything is plaintext on disk under the OS
  sandbox and file modes: records, the signing key, the TLS key, the tunnel
  token. Malware or an attacker with the unlocked device has it all. There is
  no at-rest encryption beyond the platform's.
- **A compromised Owner browser.** The same-device session cookie and the launcher's
  in-memory bearer are Owner-equivalent for their lifetime.
- **An active relay operator.** The operator controls DNS for the relay's
  domain and port 443, so it can obtain a certificate for any tunnel's
  hostname and interpose. The CAA record narrows issuance to Let's Encrypt
  over TLS-ALPN-01 and the certificate lands in the public CT logs, which
  nothing on the device watches yet (#898). Detection after the fact is the
  defence, not prevention.
- **Whoever controls `main`.** The hosted apps, the relay deploy and the
  host app's builds all come from it. A malicious commit is a malicious app
  in the Owner's browser with the scopes it was approved for.
- **An app the Owner approves.** Consent is the control. A SMART app granted
  `patient/*.rs` reads the whole compartment, and the FHIR server does not
  enforce patient compartments, so a patient-scoped token reads every
  patient (#416).
- **Traffic analysis.** The relay and anyone on the path see when the device
  is online, who connects, and how much.
- **Denial of service.** The limits (connection caps, handshake timeouts,
  rate limits) are for robustness. A determined attacker can keep a device's
  tunnel busy or exhaust the relay.
- **Backups and file sharing.** iOS keeps the data in `Documents`, visible in
  the Files app and in device backups; Android's default allows app backup.
  Whoever can read the backup can read the records.
- **The upstream components.** HFS (the FHIR server), rathole, rustls-acme
  and the Tauri plugins are depended on, not audited here.

## Known gaps

Each is a current fact of the code, listed so a reader does not have to
discover it:

- `wildflower.sqlite` can be downloaded by any token holding `wildflower/*.r`,
  and it contains the signing key's private components. The launcher's client
  holds `wildflower/*.cruds`.
- The signing key is generated once and never rotated.
- A disabled client's live access tokens work until they expire (up to 15
  minutes); the verifier does not consult the client row.
- Revocation is per client, not per grant: revoking one grant bumps the
  client's epoch and ends every refresh family of that client.
- Browser pairing (`/oauth/pair/start`) is not rate-limited, and every pairing
  raises an Owner notification.
- The relay does not retire deleted tunnel names, so a name can be created
  again for another device while the old device's certificate is still
  valid.
- Recordings (`.har`) are saved unanonymized in user-visible folders.

## See also

- [Relay Explanation](../Relay/Explanation.md) and
  [Origins Explanation](../Origins/Explanation.md), the two docs most of the
  above rests on.
- [Store Privacy Answers Reference](../../apps/host/host-app/Store%20Privacy%20Answers%20Reference.md)
  and the [privacy policy](https://wildflowerhealth.io/privacy-policy/): the
  public statements this model must stay consistent with.
