# OAuth Bindings

{{#covers apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs}}

`/oauth` is the front door: apps, devices and browsers that hold no token for this server yet. **No claims unlock its capabilities**, so each is a [`FromState`](<Live Bindings Explanation.md#item-FromState>) binding, built from the shared state alone and acquired through `Live<…>`. Where one has a gate, the gate is a proof its method takes, such as an authenticated client at `/oauth/token`, not the extractor.

Three handles here aren't for handlers at all. [`setup_authorization_server`](<Setup Explanation.md#item-setup_authorization_server>) gives them to the host, which calls them in-process: one mints launches, one mints sign-in codes, one waits on a consent.

## `live_bindings::oauth`

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs self}}

### The front-door bindings

Each is a capability over the concrete store, plus what it needs from the state. Three of them start a request the Owner must hear about, so they also get the [`OwnerApproval`](<Ports and Adapters Explanation.md#item-OwnerApproval>) port, which the shared state implements.

| Binding                         | Built for                                                                           | Takes from the state, beside the store                                        |
| ------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `LiveCodeAuthorizationStarter`  | `/oauth/authorize`                                                                  | `OwnerApproval`, the server's origin                                          |
| `LiveSameDeviceSignIn`          | `/oauth/sign-in`                                                                    | the sign-in codes, where a browser may go next, the origin, the Owner's grant |
| `LiveSessionShortfall`          | the limited page's read and cancel                                                  | nothing                                                                       |
| `LiveSessionWidening`           | the limited page's ask to widen the session, and its poll                           | `OwnerApproval`, the revocation store, the origin                             |
| `LiveBrowserPairing`            | `/oauth/pair/*`                                                                     | `OwnerApproval`, where a browser may go next, the origin                      |
| `LiveDeviceAuthorizer`          | `/oauth/device_authorization`                                                       | `OwnerApproval`, the device page's URL                                        |
| `LiveAuthorizationStatusReader` | the wait page's status poll                                                         | nothing                                                                       |
| `LivePublicKeysReader`          | `/.well-known/jwks.json`                                                            | nothing                                                                       |
| `LiveClientAuthenticator`       | the token request's extractor, for `/oauth/token` and `/oauth/device_authorization` | nothing                                                                       |
| `LiveTokenExchanger`            | `/oauth/token`                                                                      | the revocation check, the origin                                              |
| `LiveClientTokenRevoker`        | `/oauth/revoke`                                                                     | the revocation port, the origin                                               |

The capabilities themselves are on the [OAuth](<../Capabilities/OAuth Explanation.md>) pages.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveCodeAuthorizationStarter}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveCodeAuthorizationStarter::from_state}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveSameDeviceSignIn}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveSameDeviceSignIn::from_state}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveSessionShortfall}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveSessionWidening}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveSessionWidening::from_state}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveBrowserPairing}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveBrowserPairing::from_state}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveDeviceAuthorizer}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveDeviceAuthorizer::from_state}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveAuthorizationStatusReader}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LivePublicKeysReader}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveClientAuthenticator}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveTokenExchanger}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveTokenExchanger::from_state}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveClientTokenRevoker}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveClientTokenRevoker::from_state}}

No binding has a unit test of its own. The routes that build them are held end to end by the [Integration Tests](<../Integration Tests Explanation.md>).

### `LaunchContextMinter`

**How the host's own launchers start a SMART app launch.** An app launched from a launcher gets a `launch` value in its URL, which it hands to `/oauth/authorize`. The [launch context](<../Domain/Launch Context Explanation.md>) it names is minted here, in-process.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LaunchContextMinter}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LaunchContextMinter::new}}

#### `mint`

The `launch` value is a fresh random nonce ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_launch_nonce}}), and the context is built by [`for_client`](<../Domain/Launch Context Explanation.md#item-LaunchContext--for_client>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LaunchContextMinter::mint}}

The [OAuth Endpoints](<../Integration Tests/OAuth Endpoints Explanation.md#item-authorize_consumes_a_smart_launch_once>) tests hold it to being consumed once.

#### `mint_for_server_launcher`

The context is built by [`for_server_launcher`](<../Domain/Launch Context Explanation.md#item-LaunchContext--for_server_launcher>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LaunchContextMinter::mint_for_server_launcher}}

The [OAuth Endpoints](<../Integration Tests/OAuth Endpoints Explanation.md#item-authorize_consumes_a_server_launcher_launch_once>) tests hold it to being consumed once, by whichever client presents it first.

### `SameDeviceSignInCodeMinter`

**How the host signs the Owner's own browser in.** The host, on the device running the server, mints a code and opens `/oauth/sign-in?code=…&next=…` in the browser.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs SameDeviceSignInCodeMinter}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs SameDeviceSignInCodeMinter::new}}

#### `mint`

Only the code's hash is kept, in memory, so a restart drops every outstanding code ([Same-Device Sign-In Codes](<../Domain/Same Device Sign In Codes Explanation.md>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs SameDeviceSignInCodeMinter::mint}}

The [Same-Device Sign-In](<../Integration Tests/Same Device Sign In Explanation.md#item-a_code_signs_in_once>) tests hold a code to signing in once.

#### `end_signed_in_sessions`

**The minter also ends the sessions codes signed in**, through this run's store, whichever of the server's runs minted the codes: the host does once the server's last launch view closes. Each code is a [`SameDeviceSignInCode`](<../Domain/Same Device Sign In Codes Explanation.md#item-SameDeviceSignInCode>), which holds the code and the set of the run that minted it, but nothing of that run's store, so a view that outlives its run pins no run's database. The flow is the [same-device session ender](<../Capabilities/OAuth/Same Device Session Ender Explanation.md>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs SameDeviceSignInCodeMinter::end_signed_in_sessions}}

The [Same-Device Session Ending](<../Integration Tests/Same Device Session Ending Explanation.md#item-closing_a_launch_ends_only_its_session>) tests hold it to ending exactly the sessions its codes signed in, and to ending, through a restarted run, the session an earlier run's code signed in.

### `PendingConsentWatcher`

**How the host learns a consent it opened a page for is settled**, so it can close the page. The state pings it every time the [Owner prompt](<../Domain/Owner Prompt Explanation.md>) is recomputed: after every transition that may change which requests wait, and on the reaper's tick, which is how an expiry is noticed. The ping comes whether or not the prompt changed, so a request decided while a newer one stays newest is still seen to settle.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs PendingConsentWatcher}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs PendingConsentWatcher::new}}

#### `until_settled`

After every ping it rereads the request with the store's `is_awaiting_owner` (see [Owner Prompt](<../Domain/Owner Prompt Explanation.md>)), which counts a request still on its limited page as unsettled.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs PendingConsentWatcher::until_settled}}

The [OAuth Endpoints](<../Integration Tests/OAuth Endpoints Explanation.md#item-the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one>) tests hold it to seeing an older request decided under a newer one.
