# Grants

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs}}

The Owner's standing consent lives in two tables, one per kind of [grant](<../Domain/Grant Explanation.md>): `authorization_code_grants`, **one per app and redirect**, and `device_grants`, **one per app and device name**. Each pair is unique in its table, so a re-approval updates the one grant rather than adding a second. A `grants` view unions the two for the reads that don't care which kind: the Owner's list and a lookup by id. Grant ids are UUIDs unique across both tables.

**Which table a write lands in is decided in the domain**, by the caller handing over the concrete grant, never by the store inspecting a [`Grant`](<../Domain/Grant Explanation.md#item-Grant>). So there is a create, an update, a use stamp and a delete per kind. The read-then-create-or-update of a re-approval belongs to the [grant recorder](<../Writers/Grant Recorder Explanation.md>), inside one write scope, folding the approval in with [`absorb_reapproval`](<../Domain/Grant Explanation.md#item-AuthorizationCodeGrant--absorb_reapproval>) so consent only accumulates. Revoking a grant runs both deletes, since at most one hits; when neither does, the grant vanished since it was read, and the revoke answers "no such grant".

The code grant lookup by app and redirect is asked in three places: `/oauth/authorize` asks whether a request is covered by a [standing grant](<../Authority/Standing Grant Explanation.md>) so it can skip the Owner, the grant recorder asks whether an approval updates a grant or creates one, and redeeming a code asks for the grant behind it, to record its id on the refresh family it starts.

## `domain::grant_store::grants`

### `GrantsTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/grants.rs GrantsTx}}
