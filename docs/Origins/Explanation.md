# Origins Explanation

How the on-device server decides **which origin it is answering as** for a given
request, where that decision shows up (redirects, discovery documents, the links
HFS emits), and why a token's `iss` and `aud` are the one origin that doesn't
depend on it. The mechanics live in `shared-structures-rust` ([`origin_string`],
[`served_origin`]); this is the narrative those modules and their consumers
(the authorization server, FHIR R4, apps, tunnel) point back to instead of each re-deriving it.

## One listener

The server answers on one listener, the **tunnel listener**, which serves the
visitors who reach the server through the relay, at `https://<domain>`. It
binds no port: the tunnel's rathole client hands each visitor's stream to it
in process. Before HTTP, the listener reads the connection's PROXY protocol v2
header, when it opens with one, for the visitor's address, then terminates its
TLS with the certificate the device holds for the server's domain, ordered from
Let's Encrypt over TLS-ALPN-01. The relay passes TLS through by its SNI, so the
device is the only place a visitor's connection is decrypted. A handshake whose
SNI names another host gets no certificate. Its tunnel front, outside every
layer but CORS, holds each request to the server's domain, the same host the
SNI named (see
[The tunnel front writes `Forwarded`](#the-tunnel-front-writes-forwarded)).
What the relay on that path can and can't see is the
[Relay Explanation](../Relay/Explanation.md).

Nothing on the device reaches the server any other way, the host app and a
browser on the same machine included: they go out to the relay and back down
the tunnel like any remote app. So while the relay can't be reached (the
device offline, the relay down), nothing can reach the server. That holds in
development too.

## The served origin

The **served origin** is the origin the client reached: for a request
through the tunnel, the public `{scheme}://{host}` the tunnel front names,
which is always the server's origin, `https://<domain>`. A handler recovers it
per request with [`served_base_url_for`] (which returns the served base URL as
a typed `Url`; the bare origin string is derived from it). A request with no
`Forwarded` header, which only a slice's router driven directly (as its tests
do) sees, is answered as the server's origin, which each slice is handed in
its config.

The served origin is what the server renders into a redirect `Location`. The
URLs it names in documents (the SMART discovery document, HFS's links) and in
tokens are the server's origin outright (below).

### Recovering the served origin from `Forwarded` (RFC 7239)

Every consumer reads the served origin from one header, `Forwarded`, which the
tunnel front writes as a single element of its own. The parser reads the
host/scheme from the **last** forwarded-element, the one a proxy appending
its hop writes; any elements to its left are ignored. Trust comes from the
tunnel front, which replaces whatever the visitor sent, **not** from the
header's content — the header only tells a request _which_ public origin it
used.

Because the `host` ultimately derives from an attacker-influenced `Host` header
and lands in a `Location` the browser follows, it is validated (`safe_host` /
`safe_scheme`) against the delimiters that could redirect to a different
authority. A `Forwarded` header that fails validation is **rejected** (the
request `500`s), _not_ treated as unforwarded: the header's presence means the
request was relayed, so a malformed one never falls back to the server's
origin. The parsing contract and the attack cases live on the
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
- It writes `Forwarded: for=<visitor>;host="<domain>";proto=https`. The
  `for` is the visitor's address from the PROXY header, and is left out when
  the connection had none; the `host` is the domain, normalized.

Every reader of the served origin (the authorization server, FHIR R4, apps, the `404`, the
request log) then sees a tunnel request served at the public origin.

## `iss` and `aud` are the server's origin

Every JWT the authorization server mints names one origin in both its origin-shaped claims: **`iss` = `aud` =
`https://<domain>`, the server's origin**. It is the public origin the server
builds from its domain at startup (`wildflower_server.rs`), handed to the authorization server
as [`AuthorizationServerConfig::server_origin`] and to fhir-r4-rust as
[`FhirR4Config`]`.public_origin`, and spelled as a bare origin (no trailing slash,
no path) by [`origin_string`].

The claims say which server the token is for, not which origin a request was
served on, so they are checked against configuration, never against the request:

- **The authorization server's bearer gates** (the `/authorization` session gate and the bearer gate
  in front of the FHIR server and the other slices) run the `TokenVerifier`,
  which accepts a token only when its `iss` and its `aud` are both the
  configured server origin.
- **HFS** checks each bearer through the same `TokenVerifier`, run in
  process (fhir-r4-rust's `AccessTokenVerifier` port, which the host fills
  with the authorization server's `InProcessTokenVerifier`), so validating a
  token never calls the server over HTTP. A FHIR request is checked by the
  authorization server's gate and again by HFS.

So a token another server minted names that server's origin, and is refused
here by construction, even if the two servers somehow shared a signing key.

The SMART discovery document reports the server's origin as its `issuer`, and
its endpoint URLs (`authorization_endpoint`, `token_endpoint`, `jwks_uri`,
`wildflower_authorization_api`) are on the server's origin too.

A SMART app may also declare, as `aud` on `/oauth/authorize`, the FHIR server
it means to call. The authorization server checks that against the same configured origin:
it accepts `https://<domain>`, which is also the FHIR base (the `iss` every
launch hands the app), and refuses anything else with `invalid_request`. The
token's `aud` claim is the server's origin.

### HFS's `base_url` is the server's domain

HFS is the one component that can't render URLs per request. Its `base_url`
setting is the prefix of every URL it emits (search Bundle `self`/`next` links,
`entry.fullUrl`, a create's `Location`), and it ignores `Forwarded`. A client
that pages by following `next` therefore goes wherever `base_url` points.

So `base_url` is `https://<domain>`, where FHIR is served at the root, the
server's domain being the one from its record, because that is how every
client reaches the FHIR server.

The domain can't change while the server runs, so the server hands
fhir-r4-rust the public origin in its config ([`FhirR4Config`]) and HFS's router is
built once with that `base_url`; a domain that can't form an origin stops
startup. `$everything` renders the served origin per request, which through
the tunnel is the same origin.

The FHIR web UI's sign-in is the one place HFS calls the server over HTTP: it
redeems the authorization code (and refreshes the session) at
`https://<domain>/oauth/token`, out through the relay and back down the
tunnel.

### Every launch names the public origin

The apps slice resolves every app's `{origin}` to the same public origin, from
its config, whoever asked for the launch: the app reaches the FHIR server from
off the device. The launch doesn't consult the tunnel.

### Reachability is checked at the public origin

Whether a remote app can reach the server is a question about the public
origin, so that is where the server asks it. Each run, its reachability
monitor GETs the server's own `/health` at `https://<domain>/health` until
it first answers: the request leaves the device, reaches the relay, and comes
back down the tunnel to the tunnel listener, the same round trip an app's
makes. An answer, even one reporting `fail`, means reachable; no answer means
not reachable yet. The tunnel only dials and says nothing about reachability;
how well it carries traffic is `/health`'s `connectivity` check.

### Discovery is fetched before a token exists

A SMART/FHIR client fetches the discovery documents (`smart-configuration`,
`metadata`, `jwks.json`) _before_ it holds a token, so a bearer gate mounted
above the FHIR router must let those paths through unauthenticated. The canonical
allow-list is [`UNAUTHENTICATED_FHIR_PATHS`] (fhir-r4-rust), which mirrors HFS's own
`EXEMPT_PATHS`.

## The tunnel front is the trust boundary

Every request reaches a handler through the tunnel front, so the `Forwarded`
header every slice reads is the front's own, and nothing is trusted as local.
Every caller presents its own bearer (or a session cookie the server turns
into one, from its own pages only), and one without either is refused at every
gated surface. See [Apps Explanation](../Apps/Explanation.md) for how this
lands in the apps auth posture.

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
- [Wildflower Authorization Jargon Explanation](../../slices/authorization/docs/Jargon%20Explanation.md)
  — `iss` / `aud` / Owner / Client / SMART terms.
- [Relay Explanation](../Relay/Explanation.md) — the relay between a visitor
  and the tunnel listener, and what its operator is trusted with.

[`origin_string`]: ../../slices/shared-structures/shared-structures-rust/src/lib.rs
[`AuthorizationServerConfig::server_origin`]: ../../apps/host/wildflower-server/authorization-server-rust/src/config.rs
[`served_origin`]: ../../slices/shared-structures/shared-structures-rust/src/served_origin.rs
[`served_base_url_for`]: ../../slices/shared-structures/shared-structures-rust/src/served_origin.rs
[`UNAUTHENTICATED_FHIR_PATHS`]: ../../apps/host/wildflower-server/fhir-r4-rust/src/lib.rs
[`FhirR4Config`]: ../../apps/host/wildflower-server/fhir-r4-rust/src/config.rs
