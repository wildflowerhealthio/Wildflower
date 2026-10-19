# Launch Context

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs}}

A **launch context** is a SMART App Launch `launch` value this server handed out, and what it binds. When an app is launched (from the apps launch route, or from the base), the server mints an opaque value and gives it to the app. The app echoes it back at `/oauth/authorize`, and the request that presents it **consumes it, once**. A second presentation, from anyone, is refused. A launch that isn't consumed within five minutes expires.

A launch is either **for one app** or **for any app**. A launch for one app can't be spent by another: an `/authorize` from a different client is refused, and the launch stays consumable by its own app.

**Only a launch for one app can pin a patient.** When it does, the request it starts records that patient, and the Owner's approval must name the same one ([`admits_patient`](<Authorization Request Explanation.md#admits_patient>)). The client and patient fields are private, so no other shape can be built, and the table's CHECK holds the same rule. The server's in-process mints, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::mint}} and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::mint_for_any_client}}, bind no patient.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext}}

| Field         | The fact it records                                                  |
| ------------- | -------------------------------------------------------------------- |
| `nonce`       | The opaque `launch` value the app is handed and echoes back.         |
| `client_id`   | The one app the launch is for; `None` when any app may consume it.   |
| `patient`     | The patient the launch pins, if any. Set only alongside `client_id`. |
| `expires_at`  | After this, the launch can't be consumed.                            |
| `consumed_at` | When `/oauth/authorize` consumed it; `None` while it is unused.      |

Its two getters, `client_id` and `patient`, read the private fields.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::client_id LaunchContext::patient}}

## `LAUNCH_CONTEXT_TTL`

**A launch lives five minutes**, from mint to the `/authorize` that consumes it: the same as a parked authorization request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LAUNCH_CONTEXT_TTL}}

No unit test of its own.

## `for_client`

A fresh, unused launch for one app, pinning a patient when given one, expiring five minutes after it is minted.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::for_client}}

No unit test of its own; [`a_launch_admits_its_client_or_any_client`](#admits_client) builds one.

## `for_any_client`

A fresh, unused launch any app may consume. It pins no patient.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::for_any_client}}

No unit test of its own; [`a_launch_admits_its_client_or_any_client`](#admits_client) builds one.

## `admits_client`

**An app may consume a launch that is for it, or for any app.** This is the client half of consuming a launch; the consume also requires the launch to be unused and unexpired.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::admits_client}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs tests::a_launch_admits_its_client_or_any_client}}

A launch for `app` admits `app` and not `other-app`; a launch for any app names no client, pins no patient, and admits both.

## `LaunchRefusal`

Why `/oauth/authorize` could not consume a presented launch. The request is refused with `invalid_request`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchRefusal keep-docs}}

The consume is one conditional update, so of two racing requests exactly one wins. Only when it finds nothing does {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs consume_launch}} read the launch back to say why, in this order: no launch, another app's launch, already used, expired. Another app's launch is reported as that before anything else, so a wrong app never learns whether the launch was used or has expired. An expired launch that has been pruned is gone, so it reads as unknown.
