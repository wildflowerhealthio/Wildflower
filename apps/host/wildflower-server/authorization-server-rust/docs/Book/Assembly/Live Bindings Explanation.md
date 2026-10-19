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

The OAuth and Session groups also hold the in-process handles [`setup_authorization_server`](<Setup Explanation.md#setup_authorization_server>) gives the host.

## `AuthorizationServerState`

**Everything the server shares across requests**, built once by `setup_authorization_server`: the router's state, and what every capability is built from. The host gets it back inside an `Arc` and passes it to its bearer gate without looking inside. It lives at the crate root rather than under `http`, so `domain/` can be built from it without depending on the transport.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/state.rs AuthorizationServerState}}

| Field                            | What it holds                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`                          | The concrete SQLite store. Concrete, not a trait object: the capabilities are generic over the store, so the state and the axum wiring stay monomorphic.                        |
| `revocation_store`               | The shared token-revocation store, which the FHIR server's adapter reads too. The token verifier checks it; logout, `/authorization/revocations` and a grant's revoke write it. |
| `server_origin`                  | The server's bare origin, the `iss` and `aud` of every token minted here and the only ones accepted.                                                                            |
| `device_page`                    | `https://<domain>/oauth/device`, the `verification_uri` the device flow hands out.                                                                                              |
| `essential_client_guard`         | Which clients can't be disabled: the host app's and the browser-session client.                                                                                                 |
| `launcher_base`                  | The hosted launcher logout sends the browser to.                                                                                                                                |
| `owner_approval_tx`              | The channel the newest pending consent is published on, for the host to notify and the base to show.                                                                            |
| `pending_consents_recomputed_tx` | Pinged on every recompute of the newest pending consent, changed or not, for the [`PendingConsentWatcher`](<OAuth Bindings Explanation.md#pendingconsentwatcher>).              |
| `owner_grant`                    | The Owner's grant, [`OWNER_SCOPES`](<Setup Explanation.md#owner_scopes>): what an Owner session holds.                                                                          |
| `same_device_sign_in_codes`      | The outstanding same-device sign-in codes, minted by the host and redeemed at `/oauth/sign-in`.                                                                                 |
| `sign_in_destinations`           | Where `/oauth/sign-in` and a pairing may send a browser next.                                                                                                                   |
| `authorization_start_gate`       | The host's say over how fast authorization requests start.                                                                                                                      |
| `last_seen_throttle`             | Which browser sessions' last-seen time moved recently, so the rest of a page load writes nothing.                                                                               |

## `revocation`

The revocation store as the write port the capabilities revoke through ([`Revocation`](<Ports and Adapters Explanation.md#revocation>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/state.rs AuthorizationServerState::revocation}}

No unit test of its own.

## `revocation_check`

The same store as the read port the token verifier and refresh redemption ask ([`RevocationCheck`](<Ports and Adapters Explanation.md#revocationcheck>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/state.rs AuthorizationServerState::revocation_check}}

No unit test of its own.

## `FromState`

**A capability built from the state alone**: the `/oauth` front door's and the token verifier, which no claims unlock. Handlers acquire one through the `Live<F>` extractor ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/extractors/live.rs Live}}); the auth middleware and the token request's extractor build theirs directly.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/mod.rs FromState}}

No unit test of its own.
