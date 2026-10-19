# Client Auth

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs}}

A confidential client proves who it is with its secret, sent one of two ways: an `Authorization: Basic` header (`client_secret_basic`) or `client_id` and `client_secret` in the form body (`client_secret_post`). **A request presents exactly one method, and a failed Basic attempt is answered with a Basic challenge.** The same rules hold at the token endpoint and the device-authorization endpoint.

Reading the presented credentials is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs resolve_client_credentials}}; checking them is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::authenticate}}. Most tests run against [spin_up_with_confidential_client](<../Integration Tests Explanation.md#spin_up_with_confidential_client>) and send a header built by [basic_authorization](<../Integration Tests Explanation.md#basic_authorization>).

## `token_exchange_with_basic_auth_redeems_refresh_token`

**Credentials in the Basic header alone authenticate the client**, and the grant redeems.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_with_basic_auth_redeems_refresh_token}}

## `token_exchange_client_secret_post_still_authenticates_confidential_client`

**Credentials in the form body authenticate a confidential client too.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_client_secret_post_still_authenticates_confidential_client}}

## `token_exchange_wrong_basic_secret_returns_401_with_basic_challenge`

**A wrong secret in the Basic header is `401 invalid_client` with a `WWW-Authenticate: Basic` challenge**, and the response is uncached.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_wrong_basic_secret_returns_401_with_basic_challenge}}

## `token_exchange_body_secret_failure_has_no_basic_challenge`

**A wrong secret in the body is still `401 invalid_client`, but carries no Basic challenge**: the client never used the header.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_body_secret_failure_has_no_basic_challenge}}

## `token_exchange_basic_plus_body_secret_returns_400_invalid_request`

**A secret in both the header and the body is two authentication methods, refused as `invalid_request`**, even when both are right.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_basic_plus_body_secret_returns_400_invalid_request}}

## `token_exchange_basic_with_mismatched_body_client_id_returns_400_invalid_request`

**A body `client_id` that contradicts the Basic header's is `invalid_request`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_basic_with_mismatched_body_client_id_returns_400_invalid_request}}

## `token_exchange_basic_with_matching_body_client_id_succeeds`

**A body `client_id` that matches the Basic header's is tolerated.** Client libraries often send both; it is not a second method.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_basic_with_matching_body_client_id_succeeds}}

## `token_exchange_missing_client_id_returns_400_invalid_request`

**No header and no body `client_id` means there is no client to authenticate**: the request is malformed, `invalid_request`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_missing_client_id_returns_400_invalid_request}}

## `token_exchange_basic_secret_with_reserved_characters_round_trips`

**Each half of the Basic header is form-urlencoded before base64, so a secret full of reserved characters still matches.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_basic_secret_with_reserved_characters_round_trips}}

## `device_authorization_with_basic_auth_issues_device_code`

**Basic works at `/oauth/device_authorization` too**, and the client gets its device and user codes.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs device_authorization_with_basic_auth_issues_device_code}}

## `device_authorization_wrong_basic_secret_returns_401_with_basic_challenge`

**The device endpoint answers a wrong Basic secret exactly as the token endpoint does**: `401 invalid_client` with the Basic challenge.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs device_authorization_wrong_basic_secret_returns_401_with_basic_challenge}}
