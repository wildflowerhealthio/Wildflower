# Launch Context

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs}}

A **launch context** is a SMART App Launch `launch` value this server handed out, and what it binds. When an app is launched, from the apps launch route or from the base, the server mints an opaque value and gives it to the app. The app echoes it back at `/oauth/authorize`, and the request that presents it **consumes it, once**. A second presentation, from anyone, is refused. A launch that isn't consumed within five minutes expires.

A launch is either **for one app** or **for a server's launcher**. The base launches a server's launcher without knowing which app the Owner set as the launcher, so that launch is open to any app. A launch for one app can't be spent by another: an `/oauth/authorize` from a different client is refused, and the launch stays consumable by its own app.

**Only a launch for one app can bind a patient.** When it does, the [code request](<Authorization Request/Code Request Explanation.md>) it starts records that patient, and an approval must name the same one. The server's in-process mints, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::mint}} and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs LaunchContexts::mint_for_server_launcher}}, bind no patient.

## `domain::launch_context`

### `LaunchContext`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext}}

#### `for_client`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::for_client}}

#### `for_server_launcher`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::for_server_launcher}}

#### `client_id` and `patient`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::patient}}

#### `admits_client`

The client half of consuming a launch. The consume, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs consume_launch}}, also requires the launch to be unused and unexpired.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchContext::admits_client tests="tests::a_launch_admits_its_client_or_any_client"}}

### `LAUNCH_CONTEXT_TTL`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LAUNCH_CONTEXT_TTL}}

### `LaunchRefusal`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/launch_context.rs LaunchRefusal}}
