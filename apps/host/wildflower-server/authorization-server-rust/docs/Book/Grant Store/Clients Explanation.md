# Clients

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/clients.rs}}

The `clients` table holds every app the server knows, as a [`Client`](<../Domain/Client Explanation.md>) row: its registration, and whether it is disabled. Rows arrive two ways: boot-time seeding writes the server's own clients, and the Owner's approval of an app trusted on first use writes or widens that app's registration. The Owner can disable an app and enable it again; nothing deletes one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/clients.rs ClientsTx}}

## `client_by_id`

The app a request names, by its `client_id`, or `None` when the server has never seen it. Almost every flow starts here: authenticating a client at `/token`, judging a request against its registration at `/authorize`, naming the app on a consent card. **`None` is a fact the domain uses, not an error**: an unknown app is trusted on first use, so its request goes to the Owner rather than being turned away.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/clients.rs ClientsTx::client_by_id}}

The SQLite side: [`client_by_id`](<../Persistence/Clients Explanation.md#client_by_id>).

## `upsert_client`

Write a client's registration: insert it, or overwrite the policy fields of the row with the same `client_id`. **It keeps the row's `registered_at` and `disabled_at`**, so rewriting a registration never re-enables a disabled app or changes when the app first arrived. Seeding relies on it to make each server-defined client match the code on every boot; the grant recorder relies on it when an approval creates or widens a trusted-on-first-use registration, reading the row in the same write scope first.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/clients.rs ClientsTx::upsert_client}}

The SQLite side: [`upsert_client`](<../Persistence/Clients Explanation.md#upsert_client>).

## `list_clients`

Every registered app, by `client_id`, disabled ones included: the Owner's "Trusted apps" list.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/clients.rs ClientsTx::list_clients}}

The SQLite side: [`list_clients`](<../Persistence/Clients Explanation.md#list_clients>).

## `set_client_disabled`

Disable an app (`Some(at)`) or enable it again (`None`), touching no other column, so **an app comes back with its registration intact**. A disabled app is refused at `/oauth/authorize` and `/oauth/token`. The answer is whether a row with that `client_id` existed; the capability reads the row in the same write scope first, and answers "no such client" when either finds none.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/clients.rs ClientsTx::set_client_disabled}}

The SQLite side: [`set_client_disabled`](<../Persistence/Clients Explanation.md#set_client_disabled>).
