# Launch Contexts

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs}}

A SMART App Launch hands the app an opaque `launch` value, and the app echoes it back at `/oauth/authorize`. The [launch context](<../../Domain/Launch Context Explanation.md>) page says what one is: for one app or for any app, five minutes to live, spent once. This page is the two ends of its life. **Minting happens in-process, when an app is launched; consuming happens inside the `/oauth/authorize` request that presents it.**

The authorization server owns the `launch_contexts` table. Nothing outside it writes there directly. The apps slice and the base reach it through the public `LaunchContextMinter` binding, which can only mint: for one client when an app is launched, and for any client when the base launches a server's launcher, which can be any app.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts}}

`new` builds it over a store handle.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::new}}

## Test fixtures

`consume` spends a launch the way `/oauth/authorize` does: [`consume_launch`](#consume_launch) inside a write scope of the same store.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs tests::consume}}

## `mint`

**A launch for one app.** It pins no patient, expires [`LAUNCH_CONTEXT_TTL`](<../../Domain/Launch Context Explanation.md#launch_context_ttl>) after `now`, and only that app's `/oauth/authorize` can spend it. The caller supplies the `nonce` (the binding generates a random one), so a test can name it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::mint}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs tests::a_minted_context_is_consumed_once_by_its_client}}

The minted launch names `app`, pins no patient and expires after the TTL. `other-app` is refused as another app's launch without spending it, `app` then consumes it (stamped at `now`), and a replay is refused as already used.

## `mint_for_any_client`

**A launch any app may spend, once.** Otherwise the same as [`mint`](#mint): no patient, the same expiry, the same prune.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::mint_for_any_client}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs tests::a_context_for_any_client_is_consumed_once_by_any_client}}

The launch names no client and no patient. The first app to present it, `other-app`, consumes it; `app` coming second is refused as already used.

## `insert_and_prune_expired`

Both mints end here. **Every mint clears out the launches already expired**, in the same write scope as the insert, so expired launches don't pile up and need no sweeper of their own ([`delete_launch_contexts_expired_by`](<../../Grant Store/Launch Contexts Explanation.md#delete_launch_contexts_expired_by>), then [`insert_launch_context`](<../../Grant Store/Launch Contexts Explanation.md#insert_launch_context>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::insert_and_prune_expired}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs tests::minting_prunes_expired_contexts}}

`old` expires exactly at `now`; `recent` has four minutes left. After the mint at `now`, a second prune finds nothing to delete, `recent` is still consumable, and `old` is gone, so it reads as unknown.

## `consume_launch`

**A launch is spent once, by an app it admits, before it expires.** `/oauth/authorize` calls this inside its own write scope (see [`start`](<Code Authorization Starter Explanation.md#start>)), so a request refused after the consume rolls back and leaves the launch unspent.

The consume is one conditional update ([`consume_launch_context`](<../../Grant Store/Launch Contexts Explanation.md#consume_launch_context>)), so of two requests racing for one launch, exactly one wins. Only when it finds nothing is the row read back, to say why. The checks run in a fixed order:

| Order | The stored launch      | [`LaunchRefusal`](<../../Domain/Launch Context Explanation.md#launchrefusal>) |
| ----- | ---------------------- | ----------------------------------------------------------------------------- |
| 1     | no row                 | `Unknown`                                                                     |
| 2     | doesn't admit this app | `ForAnotherApp`                                                               |
| 3     | stamped consumed       | `AlreadyUsed`                                                                 |
| 4     | expired at `now`       | `Expired`                                                                     |

**Another app's launch is reported as that before its state**, so a wrong app never learns whether the launch was used or has expired, and the launch stays consumable by its own app. A launch pruned after expiring is gone, so it reads as unknown. A row that passes all four checks yet wasn't consumed can't happen; it is reported as an infrastructure error rather than a refusal.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs consume_launch}}

The outer `Result` is the store; the inner one is the launch's answer. The starter turns a refusal into the `invalid_request` the app hears, in which another app's launch reads like a forged one ([`launch_refusal_kind`](<Code Authorization Starter Explanation.md#launch_refusal_kind>)).

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs tests::a_refused_consume_says_why}}

Each case gets its own refusal. `other-app` hears `ForAnotherApp` for `live`, for `used`, and for `live` past its expiry, so the wrong app learns nothing of the launch's state. After all of them, `live` is still consumable by `app`.

Exercised end to end by [`authorize_consumes_a_smart_launch_once`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_consumes_a_smart_launch_once>), [`authorize_consumes_a_launch_for_any_client_once`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_consumes_a_launch_for_any_client_once>), [`authorize_refuses_a_bad_smart_launch_or_aud`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_refuses_a_bad_smart_launch_or_aud>), [`authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect>) and [`an_expired_launch_and_an_unknown_one_go_back_to_the_app_saying_why`](<../../Integration Tests/Session Required Explanation.md#an_expired_launch_and_an_unknown_one_go_back_to_the_app_saying_why>).
