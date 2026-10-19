# Middleware

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/cache_suppression.rs}}

The middleware are the gates a request passes before a handler sees it. Each enforces one rule:

- **Only a live token of this server's gets past a bearer gate.** Two gates check it, the session gate on `/authorization` and the bearer gate the host layers over its own routes, and both run one pipeline, so they can't disagree about a token.
- **Starting requests that may reach the Owner is rate-limited.** Anyone who knows the server's domain can start an authorization request, and each one raised for the Owner pops up on the Owner's device. The start limit asks the host whether to admit each one.
- **Nothing on `/authorization` is cached.** Every response there is privileged.

Middleware verify tokens only through the [token verifier](<../Capabilities/Session/Token Verifier Explanation.md>), never against a store; a source guard, [`middleware_verifies_only_through_the_token_verifier`](<../Capabilities Explanation.md#middleware_verifies_only_through_the_token_verifier>), holds that. `mod.rs` re-exports the pieces and names the boxed future the bearer gate's handler returns.

## `try_bearer_token_from_headers`

**The access token a request presents**: the value of an `Authorization: Bearer` header, the only credential the gates accept. The scheme matches in any case. No header, a header that isn't text, or another scheme reads as no token. The token is borrowed from the header, not copied.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs try_bearer_token_from_headers}}

No unit test of its own; every test that presents a bearer goes through it.

## `verify_request_claims`

**The one pipeline both bearer gates run.** A request with no bearer is a `401` stamped `MissingToken`. A bearer is verified by the [token verifier](<../Capabilities/Session/Token Verifier Explanation.md#verify>), with this server's origin as the only `iss` and `aud`, and a failure renders through [`verify_error_response`](<Errors and Wire Shapes Explanation.md#verify_error_response>): a `401` stamped why for a rejected or revoked token, a logged `500` when a store can't be read. On success the caller gets the verified claims. The gates differ only in what they do with them.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs verify_request_claims}}

Exercised end to end by [`the_session_gate_stamps_why_it_refused_each_401`](<../Integration Tests/Request Caller Explanation.md#the_session_gate_stamps_why_it_refused_each_401>) and [`a_token_not_naming_this_server_as_iss_and_aud_is_rejected`](<../Integration Tests/Smoke Explanation.md#a_token_not_naming_this_server_as_iss_and_aud_is_rejected>).

## `require_valid_session`

**The session gate on `/authorization`.** It proves who the caller is and nothing more: any live bearer of this server's gets through. What the caller may do there is decided per route by the `Scoped<…>` extractor, which reads the claims this gate stores and answers `403` naming the scopes the token lacks; self-service routes take `Authenticated<…>` and check no scope. The Owner's token covers every `/authorization` scope, so it passes every route's gate.

The gate stores the [`VerifiedClaims`](<../Domain/Token Explanation.md#verifiedclaims>) in the request for those extractors, so a token is verified once per request, here. On the way out it stamps the response with the caller's client as a `RequestCaller`, so the host's report of forwarded requests can say which app used the server. A `401` carries the refusal instead.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs require_valid_session}}

Exercised end to end by [`access_grants_without_auth_returns_401`](<../Integration Tests/Smoke Explanation.md#access_grants_without_auth_returns_401>), [`the_session_gate_stamps_the_token_s_client`](<../Integration Tests/Request Caller Explanation.md#the_session_gate_stamps_the_token_s_client>), [`the_session_gate_stamps_nothing_on_a_rejected_request`](<../Integration Tests/Request Caller Explanation.md#the_session_gate_stamps_nothing_on_a_rejected_request>) and the [Revocation](<../Integration Tests/Revocation Explanation.md>) gate tests.

## `authorization_server_auth_middleware`

**The bearer gate the host puts in front of its own routes**: the FHIR server, where the paths a client may read without a token are exempt, and the imaging viewer, where none are. It runs the same pipeline as the session gate. An exempt path passes untouched and its response names no caller. Any other request without a live bearer is refused with the `401`. A verified request carries the token's scopes on as `ScopeClaims`, the framework-neutral form the host's own `Scoped<…>` capabilities read, and its response names the caller's client, as the session gate's does.

The gate is built once, as a nameable layer type, and cloned onto each router.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs authorization_server_auth_middleware}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs BearerGate}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs AuthorizationServerAuthMiddleware}}

**An exempt path is matched exactly**, after trailing slashes are trimmed from both sides: an exempt `/metadata` also exempts `/metadata/`, but not `/metadata-x` or `/metadata/extra`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs is_exempt}}

### What it looks like

`exempt` is the list the tests check against, two of the FHIR server's exempt paths.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::exempt}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::exact_path_is_exempt}}

Each listed path is exempt as written.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::trailing_slashes_are_trimmed_before_matching}}

One or more trailing slashes don't change the match.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::near_misses_stay_gated}}

A path that only starts like an exempt one, one under it, and an unrelated one stay gated.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::empty_exempt_list_gates_everything}}

With no exempt paths, every path is gated.

Exercised end to end by [`bearer_gate_exempts_listed_paths_but_gates_the_rest`](<../Integration Tests/Smoke Explanation.md#bearer_gate_exempts_listed_paths_but_gates_the_rest>), [`the_bearer_gate_stamps_the_token_s_client`](<../Integration Tests/Request Caller Explanation.md#the_bearer_gate_stamps_the_token_s_client>), [`the_bearer_gate_stamps_nothing_on_a_rejected_or_exempt_request`](<../Integration Tests/Request Caller Explanation.md#the_bearer_gate_stamps_nothing_on_a_rejected_or_exempt_request>) and [`the_bearer_gate_stamps_why_it_refused_each_401`](<../Integration Tests/Request Caller Explanation.md#the_bearer_gate_stamps_why_it_refused_each_401>).

## `ensure_bearer_header`

**Give a request a bearer only if it has none.** The host's FHIR web UI keeps its signed-in user's token server-side, so a page's request carries a session cookie and no `Authorization`. The host's layer calls this to present the session's bearer, so the bearer gate checks it like any other. A request that already presents a bearer keeps its own.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs ensure_bearer_header}}

### What it looks like

`bearer` reads a request's `Authorization` header back.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::bearer}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::ensure_bearer_header_injects_when_absent}}

A request with no `Authorization` gets the session's bearer.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs tests::ensure_bearer_header_leaves_an_existing_bearer_untouched}}

A request with its own bearer keeps it.

## The authorization start limit

The limit sits on the two routes that start a request, `GET /oauth/authorize` and `POST /oauth/device_authorization`, and on every method axum serves them on (`HEAD /oauth/authorize` included), and on no other route. **The authorization server doesn't decide who is over the limit**: it knows only the request. The host, which knows the connection a request arrived on, does, through the [`AuthorizationStartGate`](<../Assembly/Ports and Adapters Explanation.md>) port, with an allowance per visitor and one overall.

**What spends from the limit is a request raised for the Owner, and only that.** Most starts ask the gate at once, before the request is even parsed, so every attempt counts, however malformed. Two kinds of start can't yet know whether they will reach the Owner, so the layer defers the question and the route asks once it knows:

- **A browser whose session can decide consents** (the Owner's own browser, typically). A request it decides on its own consent card raises nothing for the Owner. One it can't decide, and every device request, does, and asks then.
- **An `/oauth/authorize` request carrying no browser session.** The endpoint sends that browser to pairing and parks nothing, so it costs the Owner no popup, and a flood of them can't spend the allowance a paired browser's requests need.

A session the store can't vouch for, because a store can't be read, doesn't defer; it asks the gate like any other start. A request parked on the browser's limited page has spent by the time it is parked, so going on from that page asks nothing more. Asking the Owner about a request from the consent card raises it without starting one, so it spends from the same limit, when it actually raises one.

## `AuthorizationStartRoute`

Which of the two starting routes the layer guards. It decides one thing: a start carrying no browser session defers on `/oauth/authorize`, which sends it to pairing, and asks at once on `/oauth/device_authorization`, which parks every request it accepts.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs AuthorizationStartRoute}}

## `limit_authorization_starts`

**The layer on the two starting routes.** It reads the request's browser session through [`carried_browser_session`](<Browser Session Cookie Explanation.md#carried_browser_session>). A session that [can decide consents](<Browser Session Cookie Explanation.md#can_decide_consents>), or no session on `/oauth/authorize`, defers: the request goes on with a [`DeferredStartLimit`](#deferredstartlimit) for the route to ask. Otherwise the gate is asked now: admitted, the request goes on; refused, it is answered with the `429`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs limit_authorization_starts}}

Exercised end to end by [`a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route`](<../Integration Tests/Authorization Start Limit Explanation.md#a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route>), [`head_authorize_asks_the_gate`](<../Integration Tests/Authorization Start Limit Explanation.md#head_authorize_asks_the_gate>), [`an_admitted_start_is_served`](<../Integration Tests/Authorization Start Limit Explanation.md#an_admitted_start_is_served>), [`no_other_route_asks_the_gate`](<../Integration Tests/Authorization Start Limit Explanation.md#no_other_route_asks_the_gate>), [`a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate`](<../Integration Tests/Authorization Start Limit Explanation.md#a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate>), [`a_browser_signed_in_as_the_owner_passes_without_asking_the_gate`](<../Integration Tests/Authorization Start Limit Explanation.md#a_browser_signed_in_as_the_owner_passes_without_asking_the_gate>) and [`a_browser_session_that_cannot_decide_consents_asks_the_gate`](<../Integration Tests/Authorization Start Limit Explanation.md#a_browser_session_that_cannot_decide_consents_asks_the_gate>).

## `DeferredStartLimit`

**The limit, carried with the request for the route to ask later.** It holds the host's gate and the request's extensions as the layer saw them, its connection information included, which is what the gate judges a request by.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs DeferredStartLimit}}

## `admits`

Whether the gate admits the request now, spending from its allowance if it does. `/oauth/authorize` asks it before raising a request for the Owner or parking it for the limited page; the ask-owner route asks it before raising one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs DeferredStartLimit::admits}}

Exercised end to end by [`a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate`](<../Integration Tests/Authorization Start Limit Explanation.md#a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate>), [`a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate`](<../Integration Tests/Authorization Start Limit Explanation.md#a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate>) and [`a_continue_whose_start_was_counted_does_not_ask_the_gate_again`](<../Integration Tests/Authorization Start Limit Explanation.md#a_continue_whose_start_was_counted_does_not_ask_the_gate_again>).

## `StartLimitAskedNow`

**A deferred limit asked straight away**, for `/oauth/device_authorization`, every request of which is raised for the Owner. The route takes it as an extractor ahead of its body, so even a start the layer deferred is counted before the request is parsed, like any other. With no deferred limit on the request (the layer already asked), it passes; a refusal is the `429`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs StartLimitAskedNow}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs StartLimitAskedNow::from_request_parts}}

Exercised end to end by [`a_device_start_asks_the_gate_whatever_the_browser_session`](<../Integration Tests/Authorization Start Limit Explanation.md#a_device_start_asks_the_gate_whatever_the_browser_session>).

## `defer_authorization_start_limit`

**The layer on `POST /authorization/oauth-consents/{id}/ask-owner`.** Asking the Owner from the consent card raises a request for the Owner without starting one, so it spends from the same limit. This layer always defers: the route asks only when it actually raises the request, not when the request was raised already.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs defer_authorization_start_limit}}

Exercised end to end by [`asking_the_owner_is_refused_by_the_limit_and_raises_nothing`](<../Integration Tests/Authorization Start Limit Explanation.md#asking_the_owner_is_refused_by_the_limit_and_raises_nothing>) and [`asking_the_owner_spends_only_when_it_raises_a_request`](<../Integration Tests/Authorization Start Limit Explanation.md#asking_the_owner_spends_only_when_it_raises_a_request>).

## `start_limited_response`

**What a refused start hears**: `429 Too Many Requests`, a short plain-text reason, and no caching. The layer, `StartLimitAskedNow`, and the routes asking a deferred limit all answer with it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs start_limited_response}}

No unit test of its own; [`a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route`](<../Integration Tests/Authorization Start Limit Explanation.md#a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route>) checks it.

## `cache_suppress`

**Every `/authorization` response is `no-store`.** Each one carries something privileged: a pending consent, a device prompt, the standing grants, the caller's session, the outcome of an approval. Applying [`CacheSuppressed`](<Errors and Wire Shapes Explanation.md#cachesuppressed>) as one layer, outermost on the `/authorization` router, means a new route, a `404` and the session gate's own `401` all carry it without anyone remembering to.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/middleware/cache_suppression.rs cache_suppress}}

Exercised end to end by every test on the [Cache Suppression](<../Integration Tests/Cache Suppression Explanation.md>) page, for example [`unauthenticated_401_is_cache_suppressed`](<../Integration Tests/Cache Suppression Explanation.md#unauthenticated_401_is_cache_suppressed>) and [`grants_list_is_cache_suppressed`](<../Integration Tests/Cache Suppression Explanation.md#grants_list_is_cache_suppressed>).
