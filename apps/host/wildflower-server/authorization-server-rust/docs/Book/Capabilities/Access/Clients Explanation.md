# Clients

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs}}

The Owner's "Trusted apps" list is every registered [client](<../../Domain/Client Explanation.md>), with a switch to disable each. **A disabled app gets nothing**: `/oauth/authorize` and `/oauth/token` refuse it, and its pending code-flow prompts are neither shown nor approved. Disabling writes one column, `disabled_at`, so re-enabling brings the app back exactly as it was registered. Listing takes `wildflower/Client.r`; disabling and re-enabling take `wildflower/Client.u`, since both edit the row in place.

Two apps are **essential**: the host app's own client and the browser-session client. Disabling either would leave the Owner no way in, so **an essential app can't be disabled**, and the list offers no switch for it. The [`EssentialClientGuard`](<../../Domain/Client Credentials and Redirects Explanation.md#essentialclientguard>) names them.

## `clients_reader_scopes`

The gate on the list: `wildflower/Client.r`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs clients_reader_scopes}}

## `clients_disabler_scopes`

The gate on disabling and re-enabling: `wildflower/Client.u`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs clients_disabler_scopes}}

## `ClientView`

An app as the list shows it: the stored row, and whether it is essential.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientView}}

## `ClientsReader`

Read access to the registered apps, behind `GET /authorization/clients`. It holds the store and the essential-client guard.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsReader}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsReader::new ClientsDisabler::new}}

## `list`

Every registered app, disabled ones included, ordered by `client_id`, each marked essential or not. One read scope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsReader::list}}

### What it looks like

The tests name the two essential apps by the crate's own ids, and guard them as the server does.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::essential_client_guard}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::list_flags_only_the_essential_clients}}

Four apps come back in `client_id` order, and only the host app and the browser-session client are marked essential.

Exercised end to end by [`list_shows_seeded_and_trusted_on_first_use_clients_without_secrets`](<../../Integration Tests/Client Management Explanation.md#list_shows_seeded_and_trusted_on_first_use_clients_without_secrets>).

## `ClientsDisabler`

Disable or re-enable an app, behind `PATCH /authorization/clients/{clientId}`. It holds the store and the essential-client guard.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsDisabler}}

## `set_disabled_at`

**Disabling stamps `disabled_at`; re-enabling clears it; nothing else on the row moves.** The handler passes the server's own now for any disable, whatever time was sent, so a disable can't be scheduled or backdated. The answer is the row as stored.

**It is idempotent.** An app already disabled keeps its first stamp, so a repeated disable doesn't move the time, and a write that would change nothing is skipped. The read and the write share one write scope, so two concurrent disables serialise and the second keeps the first one's stamp.

Disabling an essential app is refused with `EssentialClient` before anything is read. Re-enabling one is allowed, so an essential app disabled by hand in the database can still be recovered. An unknown app is `ClientNotFound` either way, and no row is created.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsDisabler::set_disabled_at}}

### Test fixtures

`disabler_with` builds a disabler over a fake seeded with the given rows; `stored` reads a row back.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::disabler_with}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::stored}}

`at` turns seconds into a timestamp; `NOW` is the stamp a disable writes unless a test says otherwise; `disable` and `enable` call the method each way.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::at}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::NOW}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::disable}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::enable}}

The property test draws its steps over two registered apps and one id never registered.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::IDS}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::disable_then_enable_stamps_and_clears_only_disabled_at}}

A disable returns and stores the registered row with only `disabled_at` set; an enable returns and stores the registered row as it was.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::a_repeated_disable_keeps_the_first_timestamp}}

A second disable, a second later, leaves the first stamp in the answer and in the row.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::enabling_an_enabled_client_is_a_no_op}}

Enabling an enabled app leaves its row as registered.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::an_unknown_client_is_client_not_found_either_way}}

Disabling and enabling an unknown app are both `ClientNotFound`, and the store stays empty.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::an_essential_client_cannot_be_disabled_but_can_be_enabled}}

For each essential app, a disable is `EssentialClient` and writes nothing; an enable succeeds and reports it essential.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs tests::disable_and_enable_match_the_model}}

Over any sequence of disables and enables, each app's `disabled_at` matches a simple model: the stamp of the first disable since the last enable, or none. Every answer is the row as stored, every step naming the unregistered id is `ClientNotFound`, no other field moves, and no row is created.

Exercised end to end by [`any_sent_disabled_at_disables_now_with_the_servers_time`](<../../Integration Tests/Client Management Explanation.md#any_sent_disabled_at_disables_now_with_the_servers_time>), [`disable_and_enable_are_idempotent`](<../../Integration Tests/Client Management Explanation.md#disable_and_enable_are_idempotent>), [`an_unknown_client_is_a_404_either_way`](<../../Integration Tests/Client Management Explanation.md#an_unknown_client_is_a_404_either_way>), [`an_essential_client_cannot_be_disabled`](<../../Integration Tests/Client Management Explanation.md#an_essential_client_cannot_be_disabled>), [`a_disabled_client_is_refused_at_authorize_until_re_enabled`](<../../Integration Tests/Client Management Explanation.md#a_disabled_client_is_refused_at_authorize_until_re_enabled>) and [`a_disabled_client_is_refused_at_token_until_re_enabled`](<../../Integration Tests/Client Management Explanation.md#a_disabled_client_is_refused_at_token_until_re_enabled>).
