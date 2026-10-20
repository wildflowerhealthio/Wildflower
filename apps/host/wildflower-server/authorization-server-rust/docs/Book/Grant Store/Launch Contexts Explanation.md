# Launch Contexts

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/launch_contexts.rs}}

The `launch_contexts` table holds the SMART `launch` values the server has handed out, as [launch contexts](<../Domain/Launch Context Explanation.md>), keyed by the value itself (the `nonce`). **The rule this table keeps is that a launch is spent once**, by the app it is for, or by any app for one [for the server's launcher](<../Domain/Launch Context Explanation.md#item-LaunchContext--for_server_launcher>). The check and the spend are one statement, so two `/oauth/authorize` requests presenting the same launch can't both get it, and a launch presented by the wrong app stays spendable by its own.

A spent launch keeps its row, stamped consumed, until it expires. **Every mint prunes the launches already expired**, in the same write scope as its insert, so they don't pile up and need no sweeper of their own. A launch pruned this way is gone, so presenting it later reads as unknown rather than expired.

The read by `nonce` comes only after a consume found nothing, to say why: unknown, another app's, already used, or expired, in that order, so another app's launch never reveals whether it was used. That classification is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs consume_launch}}, and the refusals are the domain's [`LaunchRefusal`](<../Domain/Launch Context Explanation.md#item-LaunchRefusal>).

## `domain::grant_store::launch_contexts`

### `LaunchContextsTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/launch_contexts.rs LaunchContextsTx}}
