# Client Auth

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs}}

A confidential client proves who it is with its [credentials](<../Domain/Client Credentials Explanation.md>), sent one of two ways: an `Authorization: Basic` header (`client_secret_basic`) or `client_id` and `client_secret` in the form body (`client_secret_post`). **A request presents exactly one method, and a failed Basic attempt is answered with a Basic challenge.** The same rules hold at the token endpoint and the device-authorization endpoint.

Reading the presented credentials is [`resolve_client_credentials`](<../HTTP/Routes/Token Endpoint Explanation.md#item-resolve_client_credentials>); checking them is [`AuthenticatedClient::authenticate`](<../Authority/Authenticated Client Explanation.md#item-AuthenticatedClient--authenticate>).

## `integration::client_auth`

### `token_exchange_with_basic_auth_redeems_refresh_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_with_basic_auth_redeems_refresh_token}}

Relies on [`resolve_client_credentials`](<../HTTP/Routes/Token Endpoint Explanation.md#item-resolve_client_credentials>) and [`AuthenticatedClient::authenticate`](<../Authority/Authenticated Client Explanation.md#item-AuthenticatedClient--authenticate>). Fixtures first used here: [`spin_up_with_confidential_client`](<Test Fixtures Explanation.md#item-spin_up_with_confidential_client>), [`post_form_with_authorization`](<Test Fixtures Explanation.md#item-post_form_with_authorization>), [`basic_authorization`](<Test Fixtures Explanation.md#item-basic_authorization>), [`CONFIDENTIAL_CLIENT_ID`](<Test Fixtures Explanation.md#item-CONFIDENTIAL_CLIENT_ID>), [`CONFIDENTIAL_CLIENT_SECRET`](<Test Fixtures Explanation.md#item-CONFIDENTIAL_CLIENT_SECRET>) and [`body_json`](<Test Fixtures Explanation.md#item-body_json>).

### `token_exchange_wrong_basic_secret_returns_401_with_basic_challenge`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_wrong_basic_secret_returns_401_with_basic_challenge}}

Relies on [`AuthenticatedClient::authenticate`](<../Authority/Authenticated Client Explanation.md#item-AuthenticatedClient--authenticate>).

### `token_exchange_body_secret_failure_has_no_basic_challenge`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_body_secret_failure_has_no_basic_challenge}}

Relies on [`resolve_client_credentials`](<../HTTP/Routes/Token Endpoint Explanation.md#item-resolve_client_credentials>). Fixtures first used here: [`post_form`](<Test Fixtures Explanation.md#item-post_form>).

### `token_exchange_basic_plus_body_secret_returns_400_invalid_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_basic_plus_body_secret_returns_400_invalid_request}}

Relies on [`resolve_client_credentials`](<../HTTP/Routes/Token Endpoint Explanation.md#item-resolve_client_credentials>).

### `token_exchange_basic_with_mismatched_body_client_id_returns_400_invalid_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_basic_with_mismatched_body_client_id_returns_400_invalid_request}}

Relies on [`resolve_client_credentials`](<../HTTP/Routes/Token Endpoint Explanation.md#item-resolve_client_credentials>).

### `token_exchange_basic_with_matching_body_client_id_succeeds`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_basic_with_matching_body_client_id_succeeds}}

Relies on [`resolve_client_credentials`](<../HTTP/Routes/Token Endpoint Explanation.md#item-resolve_client_credentials>).

### `token_exchange_client_secret_post_still_authenticates_confidential_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_client_secret_post_still_authenticates_confidential_client}}

Relies on [`ClientCredentials`](<../Domain/Client Credentials Explanation.md#item-ClientCredentials>).

### `token_exchange_missing_client_id_returns_400_invalid_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_missing_client_id_returns_400_invalid_request}}

Relies on [`resolve_client_credentials`](<../HTTP/Routes/Token Endpoint Explanation.md#item-resolve_client_credentials>).

### `token_exchange_basic_secret_with_reserved_characters_round_trips`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs token_exchange_basic_secret_with_reserved_characters_round_trips}}

Relies on [`resolve_client_credentials`](<../HTTP/Routes/Token Endpoint Explanation.md#item-resolve_client_credentials>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_confidential_client`](<Test Fixtures Explanation.md#item-seed_confidential_client>), [`plant_refresh_token`](<Test Fixtures Explanation.md#item-plant_refresh_token>) and [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>).

### `device_authorization_with_basic_auth_issues_device_code`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs device_authorization_with_basic_auth_issues_device_code}}

Relies on [`DeviceAuthorizer::start`](<../Capabilities/OAuth/Device Authorizer Explanation.md#item-DeviceAuthorizer--start>).

### `device_authorization_wrong_basic_secret_returns_401_with_basic_challenge`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_auth.rs device_authorization_wrong_basic_secret_returns_401_with_basic_challenge}}

Relies on [`AuthenticatedClient::authenticate`](<../Authority/Authenticated Client Explanation.md#item-AuthenticatedClient--authenticate>).
