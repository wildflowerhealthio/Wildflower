# Launch Contexts

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs}}

The `launch_contexts` table holds one row per SMART `launch` value the server hands out: a [launch context](<../Domain/Launch Context Explanation.md>). A launch is minted in-process, and `/oauth/authorize` consumes it once. No other slice of the host reads or writes the table.

| Column        | What it holds                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `nonce`       | The `launch` value itself, in plain text: it lives five minutes and is good for one use.                                                   |
| `client_id`   | The app the launch is for. NULL means any app may consume it.                                                                              |
| `patient`     | The patient the launch pins. **The table's `CHECK (patient IS NULL OR client_id IS NOT NULL)` refuses a patient on a launch for any app.** |
| `consumed_at` | Set by the one `/authorize` that consumes it; NULL while it is unused.                                                                     |

`created_at` and `expires_at` complete the row, in diesel's chrono text encoding. The [`LaunchContext`](<../Domain/Launch Context Explanation.md>) domain type is the row: it derives diesel's mappings onto the file's `table!`.

## Test fixtures

Every test opens its own freshly migrated in-memory store.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::store}}

## `insert_launch_context`

Writes a freshly minted launch. The [mint](<../Capabilities/OAuth/Launch Contexts Explanation.md#mint>) runs it in a write scope after deleting the expired launches. Port: [`insert_launch_context`](<../Grant Store/Launch Contexts Explanation.md#insert_launch_context>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs SqliteGrantTx::insert_launch_context}}

No unit test of its own; every test below inserts through it.

## `consume_launch_context`

**A launch is consumed once, by its own app or, for a launch for any app, by whichever app presents it first.** One conditional `UPDATE … RETURNING` does the check and the stamp: it sets `consumed_at` only on the row with this `nonce` whose client is this one or NULL, whose `consumed_at` is still NULL, and whose `expires_at` is after `now`, and it returns the stamped row. The check and the write are one statement under SQLite's write lock, so **of two racing consumes of one `launch`, exactly one gets the row**; the other gets `None`. A consume that matches nothing changes nothing, so a launch presented by the wrong app stays consumable by its own. Port: [`consume_launch_context`](<../Grant Store/Launch Contexts Explanation.md#consume_launch_context>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs SqliteGrantTx::consume_launch_context}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::a_minted_context_round_trips_through_its_consume}}

The consumed row comes back exactly as inserted, with `consumed_at` set to the consume's time.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::a_context_is_consumed_once}}

The first consume gets the row; the replay gets nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::a_context_for_any_client_is_consumed_once_by_any_client}}

A launch for any app is stored with no client and consumed by the first app to present it, `other-app` here; `app` then finds nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::only_the_minted_client_consumes_an_unexpired_context}}

Another app, an unknown `nonce`, and a consume at exactly the expiry all find nothing; the launch's own app then consumes it, so the refused attempts left it untouched.

## `launch_context_by_nonce`

The launch as stored, consumed or not, expired or not. The [`consume_launch`](<../Capabilities/OAuth/Launch Contexts Explanation.md#consume_launch>) flow reads it only after a consume found nothing, to say why: unknown, another app's, already used, or expired. Port: [`launch_context_by_nonce`](<../Grant Store/Launch Contexts Explanation.md#launch_context_by_nonce>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs SqliteGrantTx::launch_context_by_nonce}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::a_context_reads_back_by_its_nonce}}

A launch reads back exactly as inserted; an unknown `nonce` reads as `None`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::a_refused_consume_says_why}}

Against the table, through the capability's [`mint`](<../Capabilities/OAuth/Launch Contexts Explanation.md#mint>) and [`consume_launch`](<../Capabilities/OAuth/Launch Contexts Explanation.md#consume_launch>): an unknown `nonce` is `Unknown`; another app's launch is `ForAnotherApp` whether it is live, used or expired, so its state is never told; a used one is `AlreadyUsed` and an expired one `Expired` to its own app. The live launch is still consumable by its own app afterwards.

## `delete_launch_contexts_expired_by`

**An expired launch can never be consumed, so nothing reads it again.** This deletes every launch whose `expires_at` is at or before `now`, consumed or not, and returns how many went. The mint calls it before each insert, so the table holds only live launches and those that expired since the last mint. Port: [`delete_launch_contexts_expired_by`](<../Grant Store/Launch Contexts Explanation.md#delete_launch_contexts_expired_by>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs SqliteGrantTx::delete_launch_contexts_expired_by}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/launch_contexts.rs tests::the_prune_deletes_only_expired_contexts}}

Of three launches, the two that expired at `now` go, consumed or not; the live one stays and can still be consumed.
