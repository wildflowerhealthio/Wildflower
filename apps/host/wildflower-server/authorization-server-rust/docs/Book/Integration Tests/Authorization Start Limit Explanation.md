# Authorization Start Limit

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs}}

Anyone who knows the server's domain can start an authorization request, and every request raised for the Owner pops up on the Owner's device. So the host keeps a limit, its [`AuthorizationStartGate`](<../Assembly/Ports and Adapters Explanation.md#item-AuthorizationStartGate>). **Every start that may bother the Owner spends from the limit once; a start the limit refuses is `429`, uncached, and parks nothing.**

The layer [`limit_authorization_starts`](<../HTTP/Middleware Explanation.md#item-limit_authorization_starts>) sits on `/oauth/authorize` and `/oauth/device_authorization` only. When a start asks depends on what it carries:

- A live browser session that can decide consents, at `/oauth/authorize`, asks only when its request is to be raised for the Owner ([`CodeRequest::raise_for_owner`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--raise_for_owner>)) or parked for the limited page. One it decides on its own [Consent Card](<Consent Card Explanation.md>) spends nothing, and going on past the limited page ([`CodeRequest::acknowledge_session_shortfall`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>)) asks nothing more.
- No live browser session, at `/oauth/authorize`, never asks: the browser is only sent to pairing.
- Anything else, and every device-authorization start, asks at once, before the request is parsed.

Asking the Owner about a request already parked (`…/ask-owner`) spends from the same limit, when it raises the request.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationauthorization_start_limit>) page, with the shared ones.

## `integration::authorization_start_limit`

### `a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_refused_start_is_429_uncached_before_it_is_parsed_on_either_route}}

Relies on [`limit_authorization_starts`](<../HTTP/Middleware Explanation.md#item-limit_authorization_starts>). Fixtures first used here: [`CountingGate`](<Test Fixtures Explanation.md#item-CountingGate>), [`spin_up_with_authorization_start_gate`](<Test Fixtures Explanation.md#item-spin_up_with_authorization_start_gate>), [`browser_session_cookie`](<Test Fixtures Explanation.md#item-common--browser_session_cookie>), [`send`](<Test Fixtures Explanation.md#item-send>) and [`body_string`](<Test Fixtures Explanation.md#item-body_string>).

### `head_authorize_asks_the_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs head_authorize_asks_the_gate}}

Relies on [`limit_authorization_starts`](<../HTTP/Middleware Explanation.md#item-limit_authorization_starts>).

### `an_admitted_start_is_served`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs an_admitted_start_is_served}}

Relies on [`limit_authorization_starts`](<../HTTP/Middleware Explanation.md#item-limit_authorization_starts>).

### `a_browser_signed_in_as_the_owner_passes_without_asking_the_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_browser_signed_in_as_the_owner_passes_without_asking_the_gate}}

Relies on [`can_decide_consents`](<../HTTP/Browser Session Cookie Explanation.md#item-can_decide_consents>). Fixtures first used here: [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>), [`signed_in_same_device_session_token`](<Test Fixtures Explanation.md#item-signed_in_same_device_session_token>), [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>) and [`REQUESTED_SCOPES`](<Test Fixtures Explanation.md#item-authorization_start_limit--REQUESTED_SCOPES>).

### `a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate}}

Relies on [`carried_browser_session`](<../HTTP/Browser Session Cookie Explanation.md#item-carried_browser_session>). Fixtures first used here: [`location_of`](<Test Fixtures Explanation.md#item-location_of>).

### `a_browser_session_that_cannot_decide_consents_asks_the_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_browser_session_that_cannot_decide_consents_asks_the_gate}}

Relies on [`can_decide_consents`](<../HTTP/Browser Session Cookie Explanation.md#item-can_decide_consents>). Fixtures first used here: [`signed_in_session_token_that_cannot_decide`](<Test Fixtures Explanation.md#item-signed_in_session_token_that_cannot_decide>).

### `no_other_route_asks_the_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs no_other_route_asks_the_gate}}

Relies on [`limit_authorization_starts`](<../HTTP/Middleware Explanation.md#item-limit_authorization_starts>).

### `a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate}}

The session holds what the request asks for, so the limited page doesn't apply. Relies on [`CodeRequest::raise_for_owner`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--raise_for_owner>). Fixtures first used here: [`decode_jwt_payload`](<Test Fixtures Explanation.md#item-decode_jwt_payload>), [`mint_browser_session_token`](<Test Fixtures Explanation.md#item-mint_browser_session_token>) and [`owner_prompt`](<Test Fixtures Explanation.md#item-owner_prompt>).

### `a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate}}

Relies on [`CodeRequest::acknowledge_session_shortfall`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>). Fixtures first used here: [`limited_request_id`](<Test Fixtures Explanation.md#item-limited_request_id>), [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>) and [`continue_past_session_shortfall`](<Test Fixtures Explanation.md#item-continue_past_session_shortfall>).

### `a_continue_whose_start_was_counted_does_not_ask_the_gate_again`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_continue_whose_start_was_counted_does_not_ask_the_gate_again}}

Relies on [`CodeRequest::acknowledge_session_shortfall`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>). Fixtures first used here: [`paired_browser_session_holding`](<Test Fixtures Explanation.md#item-paired_browser_session_holding>).

### `a_device_start_asks_the_gate_whatever_the_browser_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs a_device_start_asks_the_gate_whatever_the_browser_session}}

Relies on [`limit_authorization_starts`](<../HTTP/Middleware Explanation.md#item-limit_authorization_starts>).

### `asking_the_owner_is_refused_by_the_limit_and_raises_nothing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs asking_the_owner_is_refused_by_the_limit_and_raises_nothing}}

Relies on [`CodeRequest::raise_for_owner`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--raise_for_owner>). Fixtures first used here: [`owner_decided_request`](<Test Fixtures Explanation.md#item-owner_decided_request>), [`ask_owner`](<Test Fixtures Explanation.md#item-authorization_start_limit--ask_owner>) and [`is_decidable_in_requesting_browser`](<Test Fixtures Explanation.md#item-is_decidable_in_requesting_browser>).

### `asking_the_owner_spends_only_when_it_raises_a_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs asking_the_owner_spends_only_when_it_raises_a_request}}

Relies on [`CodeRequest::raise_for_owner`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--raise_for_owner>).
