# Origins Explanation

How the on-device server decides **which origin it is answering as** for a given
request, and why that one decision shows up in three places: a token's `iss`
claim, a token's `aud` claim, and the hostnames the subdomain reverse proxy
dispatches. The mechanics live in `shared-structures-rust`
([`CANONICAL_ISSUER`], [`served_origin`], [`subdomain_host`]); this is the
narrative those modules and their consumers (gatekeeper, emr, apps, tunnel)
point back to instead of each re-deriving it.

## Two origins: loopback and served

The embedded API server is bound to **loopback only** (`http://127.0.0.1:<port>/`).
Every remote caller reaches it the same way — a trusted front (nginx) or the
tunnel exit relays the request over that same loopback socket. So a request can
arrive having been addressed two different ways:

- **Loopback origin** — the private `http://127.0.0.1:<port>/` the on-device
  webview and other local clients use. It is `ServerRuntimeConfig.loopback_base_url`,
  parsed once at boot and threaded into every slice's config (apps, gatekeeper,
  emr, tunnel) so nothing reassembles it from a string.
- **Served origin** — the origin the client _actually_ reached. For a direct
  loopback caller it is the loopback origin. For a request relayed by the
  trusted front it is the public `{scheme}://{host}` the browser used. A handler
  recovers it per request with [`served_origin_for`].

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
authority. A header that fails validation reads as _unforwarded_ and falls back
to the loopback origin. The parsing contract, the exact nginx directive, and the
attack cases live on the [`served_origin`] module.

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
- **`aud` = the served origin** ([`served_origin_for`], per request) — so a SMART
  client can match the token's `aud` to the FHIR base URL it discovered. HFS
  leaves `aud` unvalidated; gatekeeper's own bearer gate enforces audience.

One deliberate exception: the **host owner token** carries
`aud = CANONICAL_ISSUER` (same value as its `iss`). The host presents that one
boot-minted token over loopback (the provenance-injected bearer) **and** at the
tunnel origin (the `wf_auth` cookie seeded into the native-webview popup for
cloud-app launches), so a served-origin audience would bind it to exactly one of
the two. Gatekeeper's bearer gate therefore accepts the canonical audience
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

### Discovery is fetched before a token exists

A SMART/FHIR client fetches the discovery documents (`smart-configuration`,
`metadata`, `jwks.json`) _before_ it holds a token, so a bearer gate mounted
above the FHIR router must let those paths through unauthenticated. The canonical
allow-list is [`UNAUTHENTICATED_FHIR_PATHS`] (emr-rust), which mirrors HFS's own
`EXEMPT_PATHS`.

## Subdomain dispatch for self-hosted apps

A Self-Hosted app reachable through the relay lives at a dedicated public
hostname, `https://<id>.<public_host>/`. That `<id>.<public_host>` shape has
**one** definition, [`subdomain_host`], shared by two sides that must never
drift:

- the **producer** — the apps slice's launch redirect, which emits the URL;
- the **consumer** — the host's subdomain-dispatch middleware, which matches the
  same shape on inbound forwarded requests and reverse-proxies them to that
  app's loopback static listener.

If the join changed on one side only, forwarded launches would fall through to
the API — unreachable from a remote browser, with no error. A round-trip test
pins the agreement. The split is shape-only: a matched label is still filtered
against the known-apps catalogue by the caller.

### Loopback is the trust boundary

The subdomain reverse proxy forwards a `<id>.<public_host>` request to the app's
loopback listener **before** the API's auth layer. Remote reachability of
on-device data over those hostnames therefore depends on **the trusted front
authenticating the subdomains** — the proxy adds no gate of its own. This is a
deliberate boundary: the front is the gate for the remote self-hosted surface.
The same loopback-socket gate ([`require_loopback_peer`]) is what lets every
slice trust the `Forwarded` header in the first place — a non-loopback peer is
rejected before any handler runs. See [Apps Explanation](../Apps/Explanation.md)
for how this lands in the apps auth posture.

## SMART scopes

The scope grammar a token carries (`patient`/`user`/`system` context,
`.cruds` access, SMART v1 vs v2 spellings) follows the SMART App Launch spec:
<https://build.fhir.org/ig/HL7/smart-app-launch/scopes-and-launch-context.html>.
Wildflower's parser, and the reason it mints both the v1 and v2 letter forms of a
grant (HFS's `SmartPermissions` reads only the v2 letter grammar), are documented
where they live, on `scopes-rust`'s `AccessRights` module — this doc does not
restate the grammar.

## See also

- [Apps Explanation](../Apps/Explanation.md) — provenance, the self-hosted
  subdomain surface, and the apps-side auth posture.
- [Gatekeeper Jargon Explanation](../../slices/gatekeeper/docs/Jargon%20Explanation.md)
  — `iss` / `aud` / Owner / Client / SMART terms.

[`CANONICAL_ISSUER`]: ../../slices/shared-structures/shared-structures-rust/src/lib.rs
[`served_origin`]: ../../slices/shared-structures/shared-structures-rust/src/served_origin.rs
[`served_origin_for`]: ../../slices/shared-structures/shared-structures-rust/src/served_origin.rs
[`subdomain_host`]: ../../slices/shared-structures/shared-structures-rust/src/subdomain_host.rs
[`require_loopback_peer`]: ../../slices/gatekeeper/gatekeeper-rust/src/http/middleware/require_loopback_peer.rs
[`UNAUTHENTICATED_FHIR_PATHS`]: ../../slices/emr/emr-rust/src/lib.rs
