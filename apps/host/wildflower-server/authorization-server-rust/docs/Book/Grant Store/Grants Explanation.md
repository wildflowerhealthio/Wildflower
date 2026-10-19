# Grants

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs}}

The Owner's standing consent lives in two tables, one per kind of [grant](<../Domain/Grant Explanation.md>): `authorization_code_grants`, **one per app and redirect**, and `device_grants`, **one per app and device name**. Each pair is unique in its table, so a re-approval updates the one grant rather than adding a second. A `grants` view unions the two for the reads that don't care which kind: the Owner's list and a lookup by id. Grant ids are UUIDs unique across both tables.

**Which table a write lands in is decided in the domain**, by the caller handing over the concrete grant, never by the store inspecting a [`Grant`](<../Domain/Grant Explanation.md#grant>). So there is a create, an update and a delete per kind, and the read-then-create-or-update of a re-approval belongs to the grant recorder, inside one write scope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx}}

## `all_grants`

Every grant, of both kinds, oldest `granted_at` first: the Owner's list of what each app may do.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::all_grants}}

The SQLite side: [`all_grants`](<../Persistence/Grants Explanation.md#all_grants>).

## `grant_by_id`

One grant, of either kind, by id, or `None`: the Owner opening a grant, and the read half of revoking one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::grant_by_id}}

The SQLite side: [`grant_by_id`](<../Persistence/Grants Explanation.md#grant_by_id>).

## `grant_by_client_and_redirect`

The standing authorization-code grant for this app and redirect, or `None`. Three places ask it. `/oauth/authorize` asks whether an already-registered app's request is covered by a standing grant, so it can skip asking the Owner. The grant recorder asks whether an approval updates a grant or creates one. Redeeming a code asks for the grant behind it, to record its id on the refresh family it starts.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::grant_by_client_and_redirect}}

The SQLite side: [`grant_by_client_and_redirect`](<../Persistence/Grants Explanation.md#grant_by_client_and_redirect>).

## `device_grant_by_client_and_device_name`

The standing device grant for this app and device name, or `None`: the device-flow counterpart. The grant recorder asks it when the Owner approves a device, so pairing the same device again updates its grant, and claiming a device request asks it for the grant id behind the tokens.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::device_grant_by_client_and_device_name}}

The SQLite side: [`device_grant_by_client_and_device_name`](<../Persistence/Grants Explanation.md#device_grant_by_client_and_device_name>).

## `create_authorization_code_grant`

Insert a new authorization-code grant: the Owner's first approval of this app at this redirect.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::create_authorization_code_grant}}

The SQLite side: [`create_authorization_code_grant`](<../Persistence/Grants Explanation.md#create_authorization_code_grant>).

## `create_device_grant`

Insert a new device grant: the Owner's first approval of this app on this device.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::create_device_grant}}

The SQLite side: [`create_device_grant`](<../Persistence/Grants Explanation.md#create_device_grant>).

## `update_authorization_code_grant`

Overwrite an authorization-code grant's scopes, `granted_at` and patient: the write half of a re-approval. The caller has already folded the new approval into the grant it read, with [`absorb_reapproval`](<../Domain/Grant Explanation.md#absorb_reapproval>), so consent only accumulates.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::update_authorization_code_grant}}

The SQLite side: [`update_authorization_code_grant`](<../Persistence/Grants Explanation.md#update_authorization_code_grant>).

## `update_device_grant`

The same for a device grant: the write half of pairing a device again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::update_device_grant}}

The SQLite side: [`update_device_grant`](<../Persistence/Grants Explanation.md#update_device_grant>).

## `delete_authorization_code_grant`

Delete the authorization-code grant with this id; `true` if a row went. Revoking a grant calls this and [`delete_device_grant`](#delete_device_grant) both, since ids are unique across the two tables and at most one hits. When neither does, the grant vanished since it was read, and the revoke answers "no such grant".

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::delete_authorization_code_grant}}

The SQLite side: [`delete_authorization_code_grant`](<../Persistence/Grants Explanation.md#delete_authorization_code_grant>).

## `delete_device_grant`

Delete the device grant with this id; `true` if a row went. The other half of a revoke.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx::delete_device_grant}}

The SQLite side: [`delete_device_grant`](<../Persistence/Grants Explanation.md#delete_device_grant>).
