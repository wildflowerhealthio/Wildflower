# Launch Contexts

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/launch_contexts.rs}}

The `launch_contexts` table holds the SMART `launch` values the server has handed out, as [launch contexts](<../Domain/Launch Context Explanation.md>), keyed by the value itself (the `nonce`). **The rule this table keeps is that a launch is spent once**, by the app it is for. The check and the spend are one statement, so two `/authorize` requests presenting the same launch can't both get it. A spent launch keeps its row, stamped consumed, until it expires and a later mint prunes it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/launch_contexts.rs LaunchContextsTx}}

## `insert_launch_context`

Record a freshly minted launch. Minting runs it in one write scope with [`delete_launch_contexts_expired_by`](#delete_launch_contexts_expired_by), so the table doesn't grow with abandoned launches. A duplicate `nonce` fails the insert.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/launch_contexts.rs LaunchContextsTx::insert_launch_context}}

The SQLite side: [`insert_launch_context`](<../Persistence/Launch Contexts Explanation.md#insert_launch_context>).

## `consume_launch_context`

Spend the launch: stamp it consumed at `now` and return it, **only if it is for this app or for any app, unspent, and unexpired at `now`**. Otherwise it answers `None` and changes nothing, so a launch presented by the wrong app stays spendable by its own. Of two concurrent consumes of one launch, exactly one gets it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/launch_contexts.rs LaunchContextsTx::consume_launch_context}}

The SQLite side: [`consume_launch_context`](<../Persistence/Launch Contexts Explanation.md#consume_launch_context>).

## `launch_context_by_nonce`

The launch as stored, or `None`. **It is read only after a consume found nothing**, to say why: unknown, another app's, already used, or expired, in that order, so another app's launch never reveals whether it was used. That classification is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs consume_launch}}, and the refusals are the domain's [`LaunchRefusal`](<../Domain/Launch Context Explanation.md#launchrefusal>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/launch_contexts.rs LaunchContextsTx::launch_context_by_nonce}}

The SQLite side: [`launch_context_by_nonce`](<../Persistence/Launch Contexts Explanation.md#launch_context_by_nonce>).

## `delete_launch_contexts_expired_by`

Delete every launch that expired at or before `now`, spent or not, and count them: the prune each mint runs. A launch pruned this way is gone, so presenting it later reads as unknown rather than expired.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/launch_contexts.rs LaunchContextsTx::delete_launch_contexts_expired_by}}

The SQLite side: [`delete_launch_contexts_expired_by`](<../Persistence/Launch Contexts Explanation.md#delete_launch_contexts_expired_by>).
