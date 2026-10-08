# Origins Explanation

How the on-device server decides **which origin it is answering as** for a given
request, where that decision shows up (redirects, discovery documents, the links
HFS emits), and why a token's `iss` and `aud` are the one origin that doesn't
depend on it. The mechanics live in `shared-structures-rust` ([`origin_string`],
[`served_origin`]); this is the narrative those modules and their consumers
(gatekeeper, emr, apps, tunnel) point back to instead of each re-deriving it.

## Two listeners

The server answers on two listeners, and each serves its own router, built
from the one router every slice's routes are composed into:

- **The loopback listener** (`http://127.0.0.1:<port>/`) serves the on-device
  webview and other local clients, and a front run on this machine (nginx)
  that relays remote callers over the same loopback socket. Its router adds the
  loopback owner trust and the loopback-peer gate (see
  [Loopback is the trust boundary](#loopback-is-the-trust-boundary)).
- **The tunnel listener** serves the visitors who reach the server through
  the relay. It binds no port: the tunnel's rathole client hands each
  visitor's stream to it in process. Before HTTP, the listener reads the
  connection's PROXY protocol v2 header, when it opens with one, for the
  visitor's address, then terminates its TLS with the certificate the device
  holds for the server's domain, ordered from Let's Encrypt over TLS-ALPN-01.
  The relay passes TLS through by its SNI, so the device is the only place
  a visitor's connection is decrypted. A handshake whose SNI names another
  host gets no certificate. Its router has no owner trust and no loopback-peer gate,
  so no tunnel connection is ever a local caller, whatever its peer or
  headers. Its tunnel front, outside every layer but CORS, holds each request
  to the server's public host, the same host the SNI named (see
  [The tunnel front writes `Forwarded`](#the-tunnel-front-writes-forwarded)).

## Two origins: loopback and served

A request can arrive having been addressed two different ways:

- **Loopback origin** — the private `http://127.0.0.1:<port>/` the on-device
  webview and other local clients use. It is `ServerRuntimeConfig.loopback_base_url`,
  parsed once at boot and threaded into the configs of the slices that render
  it (gatekeeper, emr) so nothing reassembles it from a string.
- **Served origin** — the origin the client _actually_ reached. For a direct
  loopback caller it is the loopback origin. For a request through the tunnel,
  or one relayed by a front, it is the public `{scheme}://{host}` the browser
  used. A handler recovers it per request with [`served_base_url_for`] (which
  returns the served base URL as a typed `Url`; the bare origin string is
  derived from it).

"Served origin" is the load-bearing concept for what the server renders: a
redirect `Location` or a discovery document's endpoints must reference the URL
the caller really used, not the loopback origin it happened to land on. Tokens
are the exception: they name the server, not the request (below).

### Recovering the served origin from `Forwarded` (RFC 7239)

Every consumer reads the served origin from one header, `Forwarded`, whichever
listener the request arrived on. A front appends its hop to any inbound
`Forwarded` chain and tacks the public `host`/`proto` onto that trailing
element; the tunnel front writes a single element of its own. The host/scheme
we trust are therefore always in the **last** forwarded-element; any
client-supplied elements sit to its left and are ignored. Trust comes from the
listener the request arrived on (see
[Loopback is the trust boundary](#loopback-is-the-trust-boundary)), **not** from
the header — the header only tells a request _which_ public origin it used.

Because the `host` ultimately derives from an attacker-influenced `Host` header
and lands in a `Location` the browser follows, it is validated (`safe_host` /
`safe_scheme`) against the delimiters that could redirect to a different
authority. A `Forwarded` header that fails validation is **rejected** (the
request `500`s), _not_ treated as loopback: the header's presence means the
request was relayed, so collapsing a malformed one to loopback would let a
relayed remote caller be mistaken for a direct-local one — and inherit the
local-owner trust the loopback listener grants on "not forwarded" (the owner
token injection). Only the **absence** of the header reads as loopback. The
parsing contract, the exact nginx directive, and the attack cases live on the
[`served_origin`] module.

### The tunnel front writes `Forwarded`

Nothing on the path from a tunnel visitor vouches for the request's headers:
the relay passes bytes through and the visitor writes the rest. So the tunnel
front, outside every layer of the tunnel listener's router but CORS, writes
the header itself:

- It drops any `Forwarded` the visitor sent.
- It compares every host the request names (each `Host` header, and the
  request target's authority, which HTTP/2 carries) with the server's public
  host, its domain, as `https` origins (so case and a spelled-out `:443` don't
  matter). A request naming another host, or none, is answered
  `421 Misdirected Request`, before the request log sees it.
- It writes `Forwarded: for=<visitor>;host="<public host>";proto=https`. The
  `for` is the visitor's address from the PROXY header, and is left out when
  the connection had none; the `host` is the public host, normalized.

Every reader of the served origin (gatekeeper, emr, apps, the `404`, the
request log) then sees a tunnel request exactly as it sees one a front
relayed, served at the public origin.

## `iss` and `aud` are the server's origin

Every JWT gatekeeper mints, whether through the OAuth flows or as the host owner
token, names one origin in both its origin-shaped claims: **`iss` = `aud` =
`https://<domain>`, the server's origin**. It is the public origin the server
builds from its domain at startup (`wildflower_server.rs`), handed to gatekeeper
as [`GatekeeperConfig::server_origin`] and to emr-rust as
[`EmrConfig`]`.public_origin`, and spelled as a bare origin (no trailing slash,
no path) by [`origin_string`].

The claims say which server the token is for, not which origin a request was
served on, so they are checked against configuration, never against the request:

- **Gatekeeper's bearer gates** (the `/access` session gate and the bearer gate
  in front of the FHIR server and the other slices) run the `TokenVerifier`,
  which accepts a token only when its `iss` and its `aud` are both the
  configured server origin.
- **HFS** checks the same pair itself: emr-rust sets HFS's `expected_issuer` and
  `expected_audience` to the server's origin, and HFS matches `aud` exactly. A
  FHIR request is checked by gatekeeper's gate and again by HFS.

Two things follow. A token for this server is accepted whichever way the request
arrived, over loopback or relayed through the tunnel, so the host owner token
and an OAuth token are the same kind of token, checked the same way. And a token
another server minted names that server's origin, so it is refused here by
construction, even if the two servers somehow shared a signing key.

The SMART discovery document reports the server's origin as its `issuer`, while
its endpoint URLs are rendered from the served origin so the SMART app can
reach them from where it is.

A SMART app may also declare, as `aud` on `/oauth/authorize`, the FHIR server
it means to call. Gatekeeper checks that against the same configured origin:
it accepts `https://<domain>` or the FHIR base `https://<domain>/fhir-r4` (the
`iss` every launch hands the app), and refuses anything else with
`invalid_request`. The token's `aud` claim is the server's origin either way.

### HFS's `base_url` is the server's public host

HFS is the one component that can't render URLs per request. Its `base_url`
setting is the prefix of every URL it emits (search Bundle `self`/`next` links,
`entry.fullUrl`, a create's `Location`), and it ignores `Forwarded`. A client
that pages by following `next` therefore goes wherever `base_url` points.

So `base_url` is `https://<public_host>/fhir-r4`, where the public host is the
server's domain from its record, because that is how remote clients reach the
FHIR server. Loopback callers get the public URLs too. Their tokens still work
there: a token names the server's origin, not the origin it was used on, so a
client that authorised over loopback can follow a public `next` link through
the tunnel.

The public host can't change while the server runs, so the server hands
emr-rust the public origin in its config ([`EmrConfig`]) and HFS's router is
built once with that `base_url`; a public host that can't form an origin stops
startup. emr-rust's own overrides (`$everything`, the SMART discovery doc) still
render the served origin per request.

### Every launch names the public origin

The apps slice resolves every app's `{origin}` to the same public origin, from
its config, whoever asked for the launch: the app reaches the FHIR server from
off the device. The launch doesn't consult the tunnel.

### Reachability is checked at the public origin

Whether a remote app can reach the server is a question about the public
origin, so that is where the server asks it. Each run, its reachability
monitor GETs the server's own `/health` at `https://<public_host>/health` until
it first answers: the request leaves the device, reaches the relay, and comes
back down the tunnel to the tunnel listener, the same round trip an app's
makes. An answer, even one reporting `fail`, means reachable; no answer means
not reachable yet. The tunnel only dials and says nothing about reachability;
how well it carries traffic is `/health`'s `connectivity` check.

### Discovery is fetched before a token exists

A SMART/FHIR client fetches the discovery documents (`smart-configuration`,
`metadata`, `jwks.json`) _before_ it holds a token, so a bearer gate mounted
above the FHIR router must let those paths through unauthenticated. The canonical
allow-list is [`UNAUTHENTICATED_FHIR_PATHS`] (emr-rust), which mirrors HFS's own
`EXEMPT_PATHS`.

## Loopback is the trust boundary

On the loopback listener, the loopback-socket gate ([`require_loopback_peer`])
is what lets every slice trust the `Forwarded` header: a non-loopback peer is
rejected before any handler runs, so every request a handler sees came from
this machine, directly or through a front run on it. On the tunnel listener the
header is the tunnel front's own, and nothing there is trusted as local. See
[Apps Explanation](../Apps/Explanation.md) for how this lands in the apps auth
posture.

## Loopback owner dialog

A direct-loopback caller is the one caller the host can put a question to in
person: nothing relayed it, so whoever started it is at this machine. The
desktop host uses that for one login. When the hosted owner UI
(`wildflower-react`, served from `https://wildflowerhealth.io/app/`) signs in to
the server on the same machine, gatekeeper parks the `/oauth/authorize` request
as usual and also asks the host to show a native Approve / Reject dialog. The
dialog names the app, the origin the login returns to, and whether the app or
that address is new. See the gatekeeper
[Jargon](../../slices/gatekeeper/docs/Jargon%20Explanation.md#loopback-owner-dialog)
for how the answer is applied.

"Direct loopback" is the same test as everywhere else in this doc: the request
carries **no** `Forwarded` header. A request through the tunnel, or relayed by
a front, never raises the dialog, whatever its `client_id`. It is decided in
the Owner UI alone, because the person who started it is remote.

The hosted page is on a public origin and calls a private-network address, so
Chrome's Local Network Access check sends a preflight carrying
`Access-Control-Request-Private-Network: true`. The host's API CORS layer
answers it with `Access-Control-Allow-Private-Network: true`. Without that
header Chrome blocks the call before it is sent.

## SMART scopes

The scope grammar a token carries (`patient`/`user`/`system` context,
`.cruds` access, SMART v1 vs v2 spellings) follows the SMART App Launch spec:
<https://build.fhir.org/ig/HL7/smart-app-launch/scopes-and-launch-context.html>.
Wildflower's parser, and the reason it mints both the v1 and v2 letter forms of a
grant (HFS's `SmartPermissions` reads only the v2 letter grammar), are documented
where they live, on `scopes-rust`'s `AccessRights` module — this doc does not
restate the grammar.

## See also

- [Apps Explanation](../Apps/Explanation.md) — launch provenance and the
  apps-side auth posture.
- [Gatekeeper Jargon Explanation](../../slices/gatekeeper/docs/Jargon%20Explanation.md)
  — `iss` / `aud` / Owner / Client / SMART terms.

[`origin_string`]: ../../slices/shared-structures/shared-structures-rust/src/lib.rs
[`GatekeeperConfig::server_origin`]: ../../slices/gatekeeper/gatekeeper-rust/src/config.rs
[`served_origin`]: ../../slices/shared-structures/shared-structures-rust/src/served_origin.rs
[`served_base_url_for`]: ../../slices/shared-structures/shared-structures-rust/src/served_origin.rs
[`require_loopback_peer`]: ../../slices/gatekeeper/gatekeeper-rust/src/http/middleware/require_loopback_peer.rs
[`UNAUTHENTICATED_FHIR_PATHS`]: ../../slices/emr/emr-rust/src/lib.rs
[`EmrConfig`]: ../../slices/emr/emr-rust/src/config.rs
