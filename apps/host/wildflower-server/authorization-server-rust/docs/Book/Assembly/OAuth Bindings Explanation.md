# OAuth Bindings

{{#covers apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs}}

`/oauth` is the front door: apps, devices and browsers that hold no token for this server yet. **No claims unlock its capabilities**, so each is a [`FromState`](<Live Bindings Explanation.md#fromstate>) binding, built from the shared state alone and acquired through `Live<…>`. Where one has a gate, the gate is a proof its method takes, such as an authenticated client at `/oauth/token`, not the extractor.

Three handles here aren't for handlers at all. [`setup_authorization_server`](<Setup Explanation.md#setup_authorization_server>) gives them to the host, which calls them in-process: one mints launches, one mints sign-in codes, one waits on a consent.

## The front-door bindings

Each is a capability over the concrete store, plus what it needs from the state. Three of them start a request the Owner must hear about, so they also get the [`OwnerApproval`](<Ports and Adapters Explanation.md#ownerapproval>) port, which the shared state implements.

| Binding                         | Built for                                                                           | Takes from the state, beside the store                                        |
| ------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `LiveCodeAuthorizationStarter`  | `/oauth/authorize`                                                                  | `OwnerApproval`, the server's origin                                          |
| `LiveSameDeviceSignIn`          | `/oauth/sign-in`                                                                    | the sign-in codes, where a browser may go next, the origin, the Owner's grant |
| `LiveSessionShortfall`          | the limited page's read and cancel                                                  | nothing                                                                       |
| `LiveBrowserPairing`            | `/oauth/pair/*`                                                                     | `OwnerApproval`, where a browser may go next, the origin                      |
| `LiveDeviceAuthorizer`          | `/oauth/device_authorization`                                                       | `OwnerApproval`, the device page's URL                                        |
| `LiveAuthorizationStatusReader` | the wait page's status poll                                                         | nothing                                                                       |
| `LivePublicKeysReader`          | `/.well-known/jwks.json`                                                            | nothing                                                                       |
| `LiveClientAuthenticator`       | the token request's extractor, for `/oauth/token` and `/oauth/device_authorization` | nothing                                                                       |
| `LiveTokenExchanger`            | `/oauth/token`                                                                      | the revocation check, the origin                                              |
| `LiveClientTokenRevoker`        | `/oauth/revoke`                                                                     | the revocation port, the origin                                               |

The capabilities themselves are on the [OAuth](<../Capabilities/OAuth Explanation.md>) pages.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveCodeAuthorizationStarter}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveCodeAuthorizationStarter::from_state}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveSameDeviceSignIn}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveSameDeviceSignIn::from_state}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveSessionShortfall}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveBrowserPairing}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveBrowserPairing::from_state}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveDeviceAuthorizer}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveDeviceAuthorizer::from_state}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveAuthorizationStatusReader}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LivePublicKeysReader}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveClientAuthenticator}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveTokenExchanger}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveTokenExchanger::from_state}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveClientTokenRevoker}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LiveClientTokenRevoker::from_state}}

No binding has a unit test of its own; the routes that build them are exercised end to end by the [Integration Tests](<../Integration Tests Explanation.md>).

## `LaunchContextMinter`

**How the host's own launchers start a SMART app launch.** An app launched from a launcher gets a `launch` value in its URL, which it hands to `/oauth/authorize`; the launch context it names is minted here, in-process. Cheap to clone: the store wraps a pool. Built over the store by `setup_authorization_server`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LaunchContextMinter}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LaunchContextMinter::new}}

No unit test of its own.

## `LaunchContextMinter::mint`

**A launch for one app**: it binds no patient, expires five minutes from now, and works for one `/oauth/authorize` by that client. The `launch` value is a fresh random nonce ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_launch_nonce}}); the context itself is the [launch context](<../Domain/Launch Context Explanation.md#for_client>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LaunchContextMinter::mint}}

Exercised end to end by [`authorize_consumes_a_smart_launch_once`](<../Integration Tests/OAuth Endpoints Explanation.md#authorize_consumes_a_smart_launch_once>).

## `mint_for_any_client`

**A launch any app may use**, for the base launching a server's launcher, which can be any app. Otherwise as above: no patient, five minutes, one `/oauth/authorize`, by whichever client presents it first ([`for_any_client`](<../Domain/Launch Context Explanation.md#for_any_client>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs LaunchContextMinter::mint_for_any_client}}

Exercised end to end by [`authorize_consumes_a_launch_for_any_client_once`](<../Integration Tests/OAuth Endpoints Explanation.md#authorize_consumes_a_launch_for_any_client_once>).

## `SameDeviceSignInCodeMinter`

**How the host signs the Owner's own browser in.** The host, on the device running the server, mints a code and opens `/oauth/sign-in?code=…&next=…` in the browser. Cheap to clone: the outstanding codes are shared with the state.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs SameDeviceSignInCodeMinter}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs SameDeviceSignInCodeMinter::new}}

No unit test of its own.

## `SameDeviceSignInCodeMinter::mint`

**Mint a one-time code.** Whoever presents it at `/oauth/sign-in` first, within 60 seconds, is signed in as the Owner. Only its hash is kept, in memory, so a restart drops every outstanding code ([Same Device Sign In Codes](<../Domain/Same Device Sign In Codes Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs SameDeviceSignInCodeMinter::mint}}

Exercised end to end by [`a_code_signs_in_once`](<../Integration Tests/Same Device Sign In Explanation.md#a_code_signs_in_once>).

## `PendingConsentWatcher`

**How the host learns a consent it opened a page for is settled**, so it can close the page. Cheap to clone. It holds the store and a receiver on the ping the state sends every time the newest pending consent is recomputed: after every transition that may change which requests are pending, and on the reaper's tick, which is how an expiry is noticed. The ping comes whether or not the newest changed, so a request decided while a newer one stays newest is still seen to settle.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs PendingConsentWatcher}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs PendingConsentWatcher::new}}

## `until_settled`

**Wait until the request no longer waits for the Owner**: decided, expired, or gone. It answers at once for one already settled. Otherwise it rereads the request ([`is_pending_in`](<../Domain/Pending Consent Explanation.md#is_pending_in>)) on a blocking thread after every ping. It fails when a read fails, or when the server stops before the request settles.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs PendingConsentWatcher::until_settled}}

Exercised end to end by [`the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one`](<../Integration Tests/OAuth Endpoints Explanation.md#the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one>).
