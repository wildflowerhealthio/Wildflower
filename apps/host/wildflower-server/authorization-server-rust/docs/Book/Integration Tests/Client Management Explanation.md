# Client Management

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs}}

The other half of trusting a [client](<../Domain/Client Explanation.md>) on first use: the Owner can see every client the server trusts, take that trust back, and change how long its sign-ins last. `GET /authorization/clients` lists them; `PATCH /authorization/clients/{id}` with `disabledAt` disables or re-enables one, and with `refreshPolicy` replaces its [refresh policy](<../Domain/Client Explanation.md#item-RefreshPolicy>). **A disabled client is refused at both OAuth front doors at once, and re-enabling it restores it with its registration intact.** The [essential clients](<../Domain/Client Explanation.md#item-is_essential_client>) can't be disabled: that would leave the Owner no way in. **A changed refresh policy applies to the client's families on their next refresh.**

The writes go through [`ClientsUpdater::set_disabled_at`](<../Capabilities/Access/Clients Explanation.md#item-ClientsUpdater--set_disabled_at>) and [`ClientsUpdater::set_refresh_policy`](<../Capabilities/Access/Clients Explanation.md#item-ClientsUpdater--set_refresh_policy>).

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationclient_management>) page, with the shared ones.

## `integration::client_management`

### `list_shows_seeded_and_trusted_on_first_use_clients_without_secrets`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs list_shows_seeded_and_trusted_on_first_use_clients_without_secrets}}

Relies on [`Client`](<../Domain/Client Explanation.md#item-Client>) and [`is_essential_client`](<../Domain/Client Explanation.md#item-is_essential_client>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_confidential_client`](<Test Fixtures Explanation.md#item-seed_confidential_client>), [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>), [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>), [`parked_request_id`](<Test Fixtures Explanation.md#item-parked_request_id>), [`approve_oauth_consent`](<Test Fixtures Explanation.md#item-approve_oauth_consent>), [`listed_clients`](<Test Fixtures Explanation.md#item-listed_clients>) and [`find_client`](<Test Fixtures Explanation.md#item-find_client>).

### `a_disabled_client_is_refused_at_authorize_until_re_enabled`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs a_disabled_client_is_refused_at_authorize_until_re_enabled}}

Relies on [`ResolvedCodeRequest::is_client_disabled`](<../Domain/Authorization Request/Code Request Explanation.md#item-ResolvedCodeRequest--is_client_disabled>). Fixtures first used here: [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>), [`disable_client`](<Test Fixtures Explanation.md#item-disable_client>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>), [`body_string`](<Test Fixtures Explanation.md#item-body_string>) and [`enable_client`](<Test Fixtures Explanation.md#item-enable_client>).

### `a_disabled_client_is_refused_at_token_until_re_enabled`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs a_disabled_client_is_refused_at_token_until_re_enabled}}

Relies on [`AuthenticatedClient::authenticate`](<../Authority/Authenticated Client Explanation.md#item-AuthenticatedClient--authenticate>), which turns down a client with `disabled_at` set. Fixtures first used here: [`spin_up_with_confidential_client`](<Test Fixtures Explanation.md#item-spin_up_with_confidential_client>), [`mint_scoped_token`](<Test Fixtures Explanation.md#item-mint_scoped_token>), [`CONFIDENTIAL_CLIENT_ID`](<Test Fixtures Explanation.md#item-CONFIDENTIAL_CLIENT_ID>) and [`refresh_as_confidential_client`](<Test Fixtures Explanation.md#item-refresh_as_confidential_client>).

### `any_sent_disabled_at_disables_now_with_the_servers_time`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs any_sent_disabled_at_disables_now_with_the_servers_time}}

Relies on [`ClientsUpdater::set_disabled_at`](<../Capabilities/Access/Clients Explanation.md#item-ClientsUpdater--set_disabled_at>). Fixtures first used here: [`disabled_at_of`](<Test Fixtures Explanation.md#item-disabled_at_of>) and [`stored_disabled_at`](<Test Fixtures Explanation.md#item-stored_disabled_at>).

### `disable_and_enable_are_idempotent`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs disable_and_enable_are_idempotent}}

Relies on [`ClientsUpdater::set_disabled_at`](<../Capabilities/Access/Clients Explanation.md#item-ClientsUpdater--set_disabled_at>).

### `an_unknown_client_is_a_404_either_way`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs an_unknown_client_is_a_404_either_way}}

Relies on [`ClientsUpdater::set_disabled_at`](<../Capabilities/Access/Clients Explanation.md#item-ClientsUpdater--set_disabled_at>). Fixtures first used here: [`patch_client`](<Test Fixtures Explanation.md#item-patch_client>).

### `a_body_without_disabled_at_is_rejected_and_writes_nothing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs a_body_without_disabled_at_is_rejected_and_writes_nothing}}

Relies on [`ClientsUpdater::set_disabled_at`](<../Capabilities/Access/Clients Explanation.md#item-ClientsUpdater--set_disabled_at>).

### `an_essential_client_cannot_be_disabled`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs an_essential_client_cannot_be_disabled}}

Relies on [`is_essential_client`](<../Domain/Client Explanation.md#item-is_essential_client>). Fixtures first used here: [`list_clients`](<Test Fixtures Explanation.md#item-list_clients>).

### `unauthenticated_callers_are_rejected`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs unauthenticated_callers_are_rejected}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>). Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `under_scoped_callers_are_rejected_before_the_handler`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs under_scoped_callers_are_rejected_before_the_handler}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).

### `a_changed_refresh_policy_applies_on_the_next_refresh`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs a_changed_refresh_policy_applies_on_the_next_refresh}}

Relies on [`ClientsUpdater::set_refresh_policy`](<../Capabilities/Access/Clients Explanation.md#item-ClientsUpdater--set_refresh_policy>) and [`ValidatedRefreshToken::validate`](<../Authority/Redemption Explanation.md#item-ValidatedRefreshToken--validate>). Fixtures first used here: [`plant_aged_family`](<Test Fixtures Explanation.md#item-plant_aged_family>), [`refresh_confidential`](<Test Fixtures Explanation.md#item-refresh_confidential>) and [`stored_refresh_policy`](<Test Fixtures Explanation.md#item-stored_refresh_policy>).

### `a_refresh_policy_is_checked_and_an_essential_client_s_can_change`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs a_refresh_policy_is_checked_and_an_essential_client_s_can_change}}

Relies on [`refresh_policy_from_body`](<../HTTP/Routes/Owner Resource Routes Explanation.md#item-refresh_policy_from_body>).

### `changing_a_refresh_policy_takes_client_update`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs changing_a_refresh_policy_takes_client_update}}

Relies on [`clients_updater_scopes`](<../Capabilities/Access/Clients Explanation.md#item-clients_updater_scopes>).
