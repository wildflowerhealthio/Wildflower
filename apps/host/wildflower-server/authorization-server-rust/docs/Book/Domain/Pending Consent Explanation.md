# Pending Consent

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs}}

A **pending consent** is an authorization request that waits for the Owner: still pending, not past its expiry, and from a client that isn't disabled. The host asks the Owner about one at a time, the newest, like a stack: a new request takes over from the one before it, and deciding it brings back the newest of those still pending. The [Jargon](<../../../../../../../slices/authorization/docs/Jargon Explanation.md#pending-consents>) says how the host learns of it.

The three kinds of request share no lookup key. A device-code request and a browser pairing are found by the `user_code` typed at the device page; an authorization-code request by its `id`, at its consent card. So this page has two types, each discriminated by kind.

**`NewestPendingConsent` is what the host shows the Owner**: the key its consent surface fetches by, plus the name of what asks, for the host's notification.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs NewestPendingConsent}}

| Field                             | What it carries                                                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_code`                       | The code a device or pairing browser shows, which the Owner types at the device page.                                                                                                                           |
| `id`                              | The authorization request's id, which is also the id of the wait page the requesting browser sits on.                                                                                                           |
| `client_name`                     | The client's registered name, or its `client_id` while a client trusted on first use has no registration, as the consent card names it.                                                                         |
| `decidable_in_requesting_browser` | The requesting browser carried a browser session that can decide consents, so it shows the consent card itself.                                                                                                 |
| `browser_name`                    | The name a pairing browser goes by: one it gave itself, or one taken from its user agent. A pairing browser is always remote; a browser on the server's own device signs in with a same-device sign-in instead. |

**`ConsentKey` names one request by that same key**, without the display name. The host's server status carries it, serialized as `{"kind": "device", "userCode": …}`, `{"kind": "browser", "userCode": …}` or `{"kind": "oauth", "id": …}`, and asks with it whether the request still waits.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs ConsentKey}}

## Test fixtures

`oauth` and `device` build a key for an authorization-code request by id and a device-code request by user code.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs tests::oauth}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs tests::device}}

## `for_request`

How the host asks the Owner about one request. The request's kind picks the variant; the client's registered name is used when there is one, and its `client_id` otherwise. The store's `newest_pending_consent` picks the newest waiting request and builds its answer with this.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs NewestPendingConsent::for_request}}

No unit test of its own; the test under [`client_is_disabled`](#client_is_disabled) reads its output through the fake store's `newest_pending_consent`.

## `client_is_disabled`

**A disabled client's request is not a pending consent.** Its consent card answers not found, so the host is never asked about it. A client with no row at all, one trusted on first use, is not disabled and stays a candidate. [`is_pending_in`](#is_pending_in) and raising a consent card for the Owner apply the rule through this function; the store's `newest_pending_consent` applies the same rule in its query.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs client_is_disabled}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs tests::a_disabled_client_s_request_is_no_pending_consent}}

A request from a client with no row is pending; once a disabled client's request is added after it, that request's key is not pending, and the newest pending consent is still the older request from the unregistered client.

## `is_pending_in`

Whether the request a key names still waits for the Owner at `now`: it exists, is [pending at](<Authorization Request Explanation.md#pending_at>) `now` (pending status, not expired), and its client is not [disabled](#client_is_disabled). A request that is missing, decided or expired doesn't wait. The host uses this to hold until a consent settles, re-reading each time the pending consents are recomputed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs ConsentKey::is_pending_in}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/pending_consent.rs tests::a_request_is_pending_until_it_is_decided_or_expires}}

Only the live pending code request and the pending device request are pending; an expired, approved or denied request, a denied device request, and keys naming no request at all are not.
