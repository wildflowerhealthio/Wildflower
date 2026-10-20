# Launch Contexts

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs}}

The `launch_contexts` table holds one row per SMART `launch` value the server hands out: a [launch context](<../Domain/Launch Context Explanation.md>), keyed by the value itself, the `nonce`, kept in plain text since it lives five minutes and is good for one use. The [`LaunchContext`](<../Domain/Launch Context Explanation.md#item-LaunchContext>) domain type is the row. A `NULL` `client_id` is a launch any app may consume, and **the table's `CHECK (patient IS NULL OR client_id IS NOT NULL)` refuses a patient on such a launch**. A launch is minted in-process, and `/oauth/authorize` consumes it once. No other slice of the host reads or writes the table.

Every test opens its own store with [`store`](<Test Fixtures Explanation.md#item-launch_contexts--tests--store>).

## `db::launch_contexts`

### `impl LaunchContextsTx for SqliteGrantTx`

The port is [`LaunchContextsTx`](<../Grant Store/Launch Contexts Explanation.md#item-LaunchContextsTx>).

#### `insert_launch_context`

The [mint](<../Capabilities/OAuth/Launch Contexts Explanation.md>) runs it in a write scope after deleting the expired launches. Every test here inserts through it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs SqliteGrantTx::insert_launch_context}}

#### `consume_launch_context`

A consume that matches nothing changes nothing, so **a launch presented by the wrong app stays consumable by its own**.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs SqliteGrantTx::consume_launch_context tests="tests::a_minted_context_round_trips_through_its_consume tests::a_context_is_consumed_once tests::a_context_for_the_server_launcher_is_consumed_once_by_any_client tests::only_the_minted_client_consumes_an_unexpired_context"}}

#### `launch_context_by_nonce`

{{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs consume_launch}} reads it only after a consume found nothing, to say why. The second test runs that classification against the table.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs SqliteGrantTx::launch_context_by_nonce tests="tests::a_context_reads_back_by_its_nonce tests::a_refused_consume_says_why"}}

#### `delete_launch_contexts_expired_by`

The mint calls it before each insert, so the table holds only live launches and those that expired since the last mint.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs SqliteGrantTx::delete_launch_contexts_expired_by tests="tests::the_prune_deletes_only_expired_contexts"}}
