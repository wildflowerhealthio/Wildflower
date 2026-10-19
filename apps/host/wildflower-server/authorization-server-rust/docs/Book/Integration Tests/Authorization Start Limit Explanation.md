# Authorization Start Limit

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs}}

Anyone who knows the server's domain can start an authorization request, and every request raised for the Owner pops up on the Owner's device. So the host keeps a limit, the {{#code-link apps/host/wildflower-server/authorization-server-rust/src/ports/authorization_start_gate.rs AuthorizationStartGate}}. **Every start that may bother the Owner spends from the limit, once; a start the limit refuses is `429`, uncached, and parks nothing.**

The layer {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs limit_authorization_starts}} sits on `/oauth/authorize` and `/oauth/device_authorization` only. It asks the gate before the request is parsed, with two exceptions that ask later or never:

| The request carries                                                    | When the gate is asked                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A live browser session that can decide consents, at `/oauth/authorize` | Only when the request is to be raised for the Owner, or parked for the limited page |
| No live browser session, at `/oauth/authorize`                         | Never: the browser is only sent to pairing                                          |
| Anything else (and every device-authorization start)                   | At once, before parsing                                                             |

Asking the Owner about a request already parked (`…/ask-owner`) spends from the same limit, when it raises the request. Read [`raise_for_owner`](<../Domain/Authorization Request Explanation.md#raise_for_owner>) and [`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) first.

Every test builds its server with [spin_up_with_authorization_start_gate](<../Integration Tests Explanation.md#spin_up_with_authorization_start_gate>).

## Helpers

The scopes the test client registers and asks for:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs REQUESTED_SCOPES}}

A gate that admits its first `admitted` requests, refuses the rest, and counts how often it is asked:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs CountingGate}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs CountingGate::refusing}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs CountingGate::asked}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs CountingGate::admit}}

A request with an optional cookie:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs send}}

A browser signed in as the Owner starting a request it decides on its own consent card; asking the Owner about a request; and whether the newest pending request is still decidable in its browser:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs owner_decided_request}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs ask_owner}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs decidable_in_requesting_browser}}

## `a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route`

**A refused start is `429`, uncached, on either route, before the request is parsed.** Both requests here are malformed; admitted, each would be a `400`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route}}

## `head_authorize_asks_the_gate`

**`HEAD /oauth/authorize` asks the gate like `GET`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs head_authorize_asks_the_gate}}

## `an_admitted_start_is_served`

**An admitted start goes on to the route**, which here answers the malformed request with `400`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs an_admitted_start_is_served}}

## `no_other_route_asks_the_gate`

**No other route asks the gate**: the token endpoint, the request and wait pages, and the JWKS are never limited.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs no_other_route_asks_the_gate}}

## `a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate`

**A browser with no live session is only sent to pairing, so it doesn't ask the gate.** A flood of them can't spend the allowance a paired browser's requests need. A device authorization without a session still asks.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate}}

## `a_browser_signed_in_as_the_owner_passes_without_asking_the_gate`

**A request the Owner's browser decides on its own consent card spends nothing**: nobody else is bothered.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_browser_signed_in_as_the_owner_passes_without_asking_the_gate}}

## `a_browser_session_that_cannot_decide_consents_asks_the_gate`

**A browser whose session can't decide consents asks the gate at once.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_browser_session_that_cannot_decide_consents_asks_the_gate}}

The session comes from [signed_in_session_token_that_cannot_decide](<../Integration Tests Explanation.md#signed_in_session_token_that_cannot_decide>).

## `a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate`

**A browser that can decide consents, but not this request, has it raised for the Owner, and asks the gate then.** Refused, nothing is parked.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate}}

The session holds what the request asks for, so the limited page doesn't apply. Relies on [`raise_for_owner`](<../Domain/Authorization Request Explanation.md#raise_for_owner>).

## `a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate`

**A deciding browser's request that falls short of its session asks the gate before it parks for the limited page.** Going on past the page raises it for the Owner without asking again. Refused, a request for another app gets `429`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate}}

Relies on [`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>), driven by [continue_past_session_shortfall](<../Integration Tests Explanation.md#continue_past_session_shortfall>).

## `a_continue_whose_start_was_counted_does_not_ask_the_gate_again`

**A browser that can't decide consents spent its start at `/oauth/authorize`, so going on past the limited page asks nothing.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_continue_whose_start_was_counted_does_not_ask_the_gate_again}}

Relies on [`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>).

## `a_device_start_asks_the_gate_whatever_the_browser_session`

**Every device request is raised for the Owner, so even the Owner's own browser asks the gate to start one.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_device_start_asks_the_gate_whatever_the_browser_session}}

## `asking_the_owner_is_refused_by_the_limit_and_raises_nothing`

**Asking the Owner about a request spends from the limit like a start.** Refused, it is `429` and the request stays decidable in its browser.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs asking_the_owner_is_refused_by_the_limit_and_raises_nothing}}

Relies on [`raise_for_owner`](<../Domain/Authorization Request Explanation.md#raise_for_owner>).

## `asking_the_owner_spends_only_when_it_raises_a_request`

**Asking the Owner spends only when it raises the request.** Asking again about a request already raised spends nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs asking_the_owner_spends_only_when_it_raises_a_request}}

Relies on [`raise_for_owner`](<../Domain/Authorization Request Explanation.md#raise_for_owner>).
