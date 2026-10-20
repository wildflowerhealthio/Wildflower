# Clients

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/clients.rs}}

The `clients` table holds every app the server knows, as a [`Client`](<../Domain/Client Explanation.md#item-Client>): its registration, and whether it is disabled. Rows arrive two ways: boot-time [seeding](<../Assembly/Seeding Explanation.md>) writes the server's own clients, and the Owner's approval of an app trusted on first use writes or widens that app's registration. The Owner can disable an app and enable it again; nothing deletes one.

**A missing row is a fact the domain uses, not an error.** An app trusted on first use has no row until the Owner first approves it, so its request goes to the Owner rather than being turned away, and it reads as enabled. **Rewriting a registration never re-enables a disabled app** or changes when the app first arrived: seeding relies on that to make each server-defined client match the code on every boot, and the [grant recorder](<../Writers/Grant Recorder Explanation.md>) relies on it when an approval widens a registration.

## `domain::grant_store::clients`

### `ClientsTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/clients.rs ClientsTx}}
