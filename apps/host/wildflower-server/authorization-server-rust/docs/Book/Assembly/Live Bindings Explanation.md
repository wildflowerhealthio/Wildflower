# Live Bindings

{{#covers apps/host/wildflower-server/authorization-server-rust/src/live_bindings/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/live_bindings/state.rs}}

The capabilities in `domain/` are generic over the store, so their unit tests run against the in-memory fake. **The live bindings are where they meet the real thing**: each names a capability over the concrete `SqliteGrantStore`, and says how to build it from the server's shared state. A handler never names the state. It names a `Live…` binding in its extractor, and the extractor builds the capability, or refuses the request first.

A binding lifts only the handles its capability needs out of the state, never the whole state, so `domain/` depends neither on `http` nor on the concrete adapters. The bindings come in three groups, one page each, by how a handler acquires them:

| Group                                        | Acquired through              | Unlocked by                                                                                                |
| -------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Access](<Access Bindings Explanation.md>)   | `Scoped<…>`                   | The caller's scopes, checked before the capability exists.                                                 |
| [OAuth](<OAuth Bindings Explanation.md>)     | `Live<…>`                     | Nothing: the `/oauth` front door. Where there is a gate, it is a proof the method takes.                   |
| [Session](<Session Bindings Explanation.md>) | `Authenticated<…>`, `Live<…>` | A verified token alone, for a caller acting on its own session; or nothing, for the token verifier itself. |

The OAuth and Session groups also hold the in-process handles [`setup_authorization_server`](<Setup Explanation.md#item-setup_authorization_server>) gives the host.

## `live_bindings::state`

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/state.rs self}}

### `AuthorizationServerState`

**Everything the server shares across requests**, built once by `setup_authorization_server`. The host gets it back inside an `Arc` and passes it to its bearer gate without looking inside.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/state.rs AuthorizationServerState}}

#### `revocation`

The write port is [`Revocation`](<Ports and Adapters Explanation.md#item-Revocation>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/state.rs AuthorizationServerState::revocation}}

#### `revocation_check`

The read port is [`RevocationCheck`](<Ports and Adapters Explanation.md#item-RevocationCheck>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/state.rs AuthorizationServerState::revocation_check}}

## `live_bindings`

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/mod.rs self}}

### `FromState`

Handlers acquire one through the [`Live<F>`](<../HTTP/Extractors Explanation.md#item-Live>) extractor; the auth middleware and the token request's extractor build theirs directly.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/mod.rs FromState}}
