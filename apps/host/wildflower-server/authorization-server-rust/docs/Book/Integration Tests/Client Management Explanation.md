# Client Management

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs}}

The other half of trusting a client on first use: the Owner can see every client the server trusts and take that trust back. `GET /authorization/clients` lists them; `PATCH /authorization/clients/{id}` with `disabledAt` disables or re-enables one. **A disabled client is refused at both OAuth front doors at once, and re-enabling it restores it with its registration intact.** Read the [Client](<../Domain/Client Explanation.md>) page first.

The write goes through {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsDisabler::set_disabled_at}}.

## Helpers

The list call, and its rows once it has succeeded:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs list_clients}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs listed_clients}}

One client's row in a list, its stored `disabled_at`, and the `disabledAt` a response body carries:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs find_client}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs stored_disabled_at}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs disabled_at_of}}

A refresh the confidential test client can always make, so a refusal can only be the client's state:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs refresh_as_confidential_client}}

The PATCH itself is [patch_client](<../Integration Tests Explanation.md#patch_client>), wrapped by [disable_client](<../Integration Tests Explanation.md#disable_client>) and [enable_client](<../Integration Tests Explanation.md#enable_client>).

## `list_shows_seeded_and_trusted_on_first_use_clients_without_secrets`

**The list shows every client the server trusts, however it came to: seeded at boot, seeded by migration, or trusted on first use.** It is ordered by id, flags the essential clients, and never carries a secret.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs list_shows_seeded_and_trusted_on_first_use_clients_without_secrets}}

The client trusted on first use is listed exactly as its approval registered it. Relies on [`Client`](<../Domain/Client Explanation.md#client>).

## `a_disabled_client_is_refused_at_authorize_until_re_enabled`

**A disabled client's authorize request gets a local error page, never a redirect to the client or a prompt to the Owner.** Re-enabled, the same request parks again.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs a_disabled_client_is_refused_at_authorize_until_re_enabled}}

The PATCH answers with the row the list shows. Relies on [`Client`](<../Domain/Client Explanation.md#client>).

## `a_disabled_client_is_refused_at_token_until_re_enabled`

**A disabled client is refused at the token endpoint with `invalid_client`, and the refusal consumes nothing.** Re-enabled, the same refresh token redeems.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs a_disabled_client_is_refused_at_token_until_re_enabled}}

The refusal is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::authenticate}} turning down a client with `disabled_at` set.

## `any_sent_disabled_at_disables_now_with_the_servers_time`

**Whatever time is sent, the client is disabled now, stamped with the server's clock.** A disable can be neither backdated nor scheduled.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs any_sent_disabled_at_disables_now_with_the_servers_time}}

## `disable_and_enable_are_idempotent`

**A repeated disable keeps the first timestamp, and a repeated enable is harmless.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs disable_and_enable_are_idempotent}}

## `an_unknown_client_is_a_404_either_way`

**Disabling or enabling a client that doesn't exist is `404 ClientNotFound`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs an_unknown_client_is_a_404_either_way}}

## `a_body_without_disabled_at_is_rejected_and_writes_nothing`

**The body must name `disabledAt`, and nothing else.** A missing field is not read as `null` (which would re-enable the client); an unknown field or an unparseable time is refused. None of them writes.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs a_body_without_disabled_at_is_rejected_and_writes_nothing}}

## `an_essential_client_cannot_be_disabled`

**The host app's client and the browser-session client can't be disabled: that would leave the Owner no way in.** The attempt is `409 EssentialClient`; enabling them stays allowed.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs an_essential_client_cannot_be_disabled}}

The rule is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/essential_client_guard.rs EssentialClientGuard::is_essential}}.

## `unauthenticated_callers_are_rejected`

**Listing and updating clients both need a bearer.** Without one, each is a `401` and nothing is written.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs unauthenticated_callers_are_rejected}}

## `under_scoped_callers_are_rejected_before_the_handler`

**Listing takes `wildflower/Client.r`; updating takes `wildflower/Client.u`.** The scope gate runs before the handler, so even an unknown client is a `403`, not a `404`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs under_scoped_callers_are_rejected_before_the_handler}}
