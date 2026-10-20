# Launch Contexts

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs}}

A SMART App Launch hands the app an opaque `launch` value, and the app echoes it back at `/oauth/authorize`. The [launch context](<../../Domain/Launch Context Explanation.md>) page says what one is: for one app or for a server's launcher, five minutes to live, spent once. This page is the two ends of its life. **Minting happens in-process, when an app is launched; consuming happens inside the `/oauth/authorize` request that presents it.**

The authorization server owns the `launch_contexts` table, and nothing outside it writes there directly. The apps slice and the base reach it through the public `LaunchContextMinter` binding, which can only mint. Every mint clears out the launches already expired in the same write scope, so expired launches need no sweeper of their own.

The tests consume a launch [as `/oauth/authorize` does](<../Test Fixtures Explanation.md#launch-contexts>), inside a write scope of the same store.

## `domain::capabilities::oauth::launch_contexts`

### `LaunchContexts`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::new}}

#### `mint`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::mint tests="tests::a_minted_context_is_consumed_once_by_its_client"}}

#### `mint_for_server_launcher`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::mint_for_server_launcher tests="tests::a_context_for_the_server_launcher_is_consumed_once_by_any_client"}}

#### `insert_and_prune_expired`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::insert_and_prune_expired tests="tests::minting_prunes_expired_contexts"}}

### `consume_launch`

**Another app's launch is reported as that before its state**, so a wrong app never learns whether the launch was used or has expired. The starter goes further and tells the app another app's launch [as if it were forged](<Code Authorization Starter Explanation.md#item-launch_refusal_kind>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs consume_launch tests="tests::a_refused_consume_says_why"}}
