# Origins Explanation

How the on-device server decides **which origin it is answering as** for a given
request, and why that one decision shows up in two places: a token's `iss`
claim and a token's `aud` claim. The mechanics live in `shared-structures-rust`
([`CANONICAL_ISSUER`], [`served_origin`]); this is the
narrative those modules and their consumers (gatekeeper, emr, apps, tunnel)
point back to instead of each re-deriving it.

## Two origins: loopback and served

The embedded API server is bound to **loopback only** (`http://127.0.0.1:<port>/`).
Every remote caller reaches it the same way — a trusted front (nginx) or the
tunnel exit relays the request over that same loopback socket. So a request can
arrive having been addressed two different ways:

- **Loopback origin** — the private `http://127.0.0.1:<port>/` the on-device
  webview and other local clients use. It is `ServerRuntimeConfig.loopback_base_url`,
  parsed once at boot and threaded into the configs of the slices that render
  it (gatekeeper, emr) so nothing reassembles it from a string.
- **Served origin** — the origin the client _actually_ reached. For a direct
  loopback caller it is the loopback origin. For a request relayed by the
  trusted front it is the public `{scheme}://{host}` the browser used. A handler
  recovers it per request with [`served_base_url_for`] (which returns the served
  base URL as a typed `Url`; the bare origin string is derived from it).

"Served origin" is the load-bearing concept: a token, a redirect `Location`, or
a discovery document must reference the URL the caller really used, not the
loopback origin it happened to land on.

### Recovering the served origin from `Forwarded` (RFC 7239)

The trusted front appends its hop to any inbound `Forwarded` chain and tacks the
public `host`/`proto` onto that trailing element. The host/scheme we trust are
therefore always in the **last** forwarded-element; any client-supplied elements
sit to its left and are ignored. Trust comes from the loopback-socket gate (see
[Loopback peer gating](#loopback-is-the-trust-boundary)), **not** from the header
— the header only tells a gated-as-trusted request _which_ public origin it used.

Because the `host` ultimately derives from an attacker-influenced `Host` header
and lands in a `Location` the browser follows, it is validated (`safe_host` /
`safe_scheme`) against the delimiters that could redirect to a different
authority. A `Forwarded` header that fails validation is **rejected** (the
request `500`s), _not_ treated as loopback: the header's presence means the
request came through the front, so collapsing a malformed one to loopback would
let a tunnel-relayed remote caller be mistaken for a direct-local one — and
inherit the local-owner trust that is gated purely on "not forwarded" (e.g. the
desktop host's owner-token injection). Only the **absence** of the header reads
as loopback. The parsing contract, the exact nginx directive, and the attack
cases live on the [`served_origin`] module.

## `iss` is the canonical origin; `aud` is the served origin

Every JWT gatekeeper mints carries two origin-shaped claims, derived differently
on purpose:

- **`iss` = [`CANONICAL_ISSUER`]** — a single, build-time-fixed string
  (`https://wildflowerhealth.io`), the same value HFS validates against. Pinning
  it means one `expected_issuer` accepts every gatekeeper-signed token whether it
  was minted for a loopback caller or a tunnel caller, with no
  loopback-vs-tunnel branching at mint time or validation time. Wildflower is
  single-tenant for now; a per-deployment issuer is deferred until a second
  tenant justifies it.
- **`aud` = the served origin** ([`served_base_url_for`], per request) — so a
  SMART client can match the token's `aud` to the FHIR base URL it discovered.
  HFS leaves `aud` unvalidated; gatekeeper's own bearer gate enforces audience.

One deliberate exception: the **host owner token** carries
`aud = CANONICAL_ISSUER` (same value as its `iss`). The host presents that one
boot-minted token over loopback (the provenance-injected bearer), and the same
token must also verify on a forwarded (tunnel-origin) request, so a served-origin
audience would bind it to exactly one of the two. Gatekeeper's bearer gate therefore accepts the canonical audience
alongside the per-request served-origin pair. OAuth-minted tokens always get
`{origin}/fhir-r4` — the canonical audience is never mintable through the OAuth
surface.

Because the canonical audience is accepted at **every** served origin, accepting
it can't rest on convention alone. The host owner token additionally carries a
`wf_owner` marker claim, and the bearer gate honours the canonical audience
**only** for a token that carries it. Any other token that reaches the gate via
`aud = CANONICAL_ISSUER` — a future minting bug, a copied pattern, a
leaked-and-replayed token — is rejected, so every non-owner token stays bound to
its served origin. The marker is a private claim (absent, never `false`, on
every other token), so it costs nothing on the wire and is invisible to SMART
clients.

The SMART discovery document follows the same split: its `issuer` field is
[`CANONICAL_ISSUER`], while its endpoint URLs are rendered from the served origin
so the SMART app can actually reach them from where it is.

### HFS's `base_url` is the server's public host

HFS is the one component that can't render URLs per request. Its `base_url`
setting is the prefix of every URL it emits (search Bundle `self`/`next` links,
`entry.fullUrl`, a create's `Location`), and it ignores `Forwarded`. A client
that pages by following `next` therefore goes wherever `base_url` points, and
its token's `aud` has to match.

So `base_url` is `https://<public_host>/fhir-r4`, where the public host is the
server's domain from its record, because that is how remote clients reach the
FHIR server. Loopback callers get the public URLs too. That suits the host
owner token, whose canonical audience is accepted at every served origin, but
not an OAuth-minted token whose `aud` is the loopback base: a client that
authorised over loopback and follows a public `next` link through the tunnel is
refused. A launched app never does, since every launch names the public origin
(below).

The public host can't change while the server runs, so the server hands
emr-rust the public origin in its config ([`EmrConfig`]) and HFS's router is
built once with that `base_url`; a public host that can't form an origin stops
startup. emr-rust's own overrides (`$everything`, the SMART discovery doc) still
render the served origin per request.

### Every launch names the public origin

The apps slice resolves every app's `{origin}` to the same public origin, from
its config, whoever asked for the launch: the app reaches the FHIR server from
off the device. The launch doesn't consult the tunnel; the tunnel belongs to the
host, and the server's web surface knows nothing about it.

### Reachability is checked at the public origin

Whether a remote app can reach the server is a question about the public
origin, so that is where the server asks it. Each run, its reachability
monitor GETs the server's own `/health` at `https://<public_host>/health` until
it first answers: the request leaves the device, reaches the relay, and comes
back down the tunnel as a forwarded request, the same round trip an app's
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

The loopback-socket gate ([`require_loopback_peer`]) is what lets every slice
trust the `Forwarded` header: a non-loopback peer is rejected before any handler
runs, so every request a handler sees came from this machine or through the
trusted front. See [Apps Explanation](../Apps/Explanation.md) for how this lands
in the apps auth posture.

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
carries **no** `Forwarded` header. A request relayed by the trusted front never
raises the dialog, whatever its `client_id`. It is decided in the Owner UI
alone, because the person who started it is remote.

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

[`CANONICAL_ISSUER`]: ../../slices/shared-structures/shared-structures-rust/src/lib.rs
[`served_origin`]: ../../slices/shared-structures/shared-structures-rust/src/served_origin.rs
[`served_base_url_for`]: ../../slices/shared-structures/shared-structures-rust/src/served_origin.rs
[`require_loopback_peer`]: ../../slices/gatekeeper/gatekeeper-rust/src/http/middleware/require_loopback_peer.rs
[`UNAUTHENTICATED_FHIR_PATHS`]: ../../slices/emr/emr-rust/src/lib.rs
[`EmrConfig`]: ../../slices/emr/emr-rust/src/config.rs
