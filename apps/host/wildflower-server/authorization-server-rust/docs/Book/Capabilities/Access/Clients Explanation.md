# Clients

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs}}

The Owner's "Trusted apps" list is every registered [client](<../../Domain/Client Explanation.md>), with a switch to disable each. **A disabled app gets nothing**: `/oauth/authorize` and `/oauth/token` refuse it, and its waiting code requests are neither shown nor approved. Disabling writes one column, `disabled_at`, so re-enabling brings the app back exactly as it was registered. Disabling and re-enabling both edit the row in place, so both take `wildflower/Client.u`.

The two [essential clients](<../../Domain/Client Explanation.md#item-is_essential_client>) are how the Owner gets in, so **an essential app can't be disabled**, and the list offers no switch for it. Re-enabling one is allowed, so an essential app disabled by hand in the database can still be recovered.

## `domain::capabilities::access::clients`

### `clients_reader_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs clients_reader_scopes}}

### `clients_disabler_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs clients_disabler_scopes}}

### `ClientView`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientView}}

### `ClientsReader`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsReader}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsReader::new}}

#### `list`

The test names the essential apps by the [crate's own ids](<../Test Fixtures Explanation.md#clients>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsReader::list tests="tests::list_flags_only_the_essential_clients"}}

### `ClientsDisabler`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsDisabler}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsDisabler::new}}

#### `set_disabled_at`

The tests disable and enable through the [disabler fixtures](<../Test Fixtures Explanation.md#clients>), each disable stamped at a fixed second unless the test says otherwise. The property test runs any sequence of steps over two registered apps and one id never registered.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/clients.rs ClientsDisabler::set_disabled_at tests="tests::disable_then_enable_stamps_and_clears_only_disabled_at tests::a_repeated_disable_keeps_the_first_timestamp tests::enabling_an_enabled_client_is_a_no_op tests::an_unknown_client_is_client_not_found_either_way tests::an_essential_client_cannot_be_disabled_but_can_be_enabled tests::disable_and_enable_match_the_model"}}
