# Bearer Only

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs}}

**The bearer gates read the `Authorization: Bearer` header and nothing else.** No grant hands a token back as a cookie, a token carried in a `wf_auth` cookie authenticates nothing, and logout sets no cookies. The browser session's cookie, set at sign-in ([Browser Sessions](<Browser Sessions Explanation.md>)), reaches the gates only through the host's cookie-to-bearer layer, which presents its token as the request's bearer.

Responses are read with [set_cookie_values](<../Integration Tests Explanation.md#one-liners>).

## `a_device_grant_sets_no_cookie`

**A device grant returns its token in the JSON body only.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs a_device_grant_sets_no_cookie}}

The approved request is planted by [plant_device_request](<../Integration Tests Explanation.md#plant_device_request>).

## `a_refresh_grant_sets_no_cookie`

**A refresh grant returns its token in the JSON body only.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs a_refresh_grant_sets_no_cookie}}

## `a_cookie_carried_token_is_not_a_credential`

**A valid Owner token sent as a `wf_auth` cookie, with no bearer header, is unauthenticated.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs a_cookie_carried_token_is_not_a_credential}}

## `logout_redirects_to_the_launcher_without_cookies`

**Logout sends the browser to the launcher and sets no cookies.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs logout_redirects_to_the_launcher_without_cookies}}
