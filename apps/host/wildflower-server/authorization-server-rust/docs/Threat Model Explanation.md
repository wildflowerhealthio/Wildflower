# Threat Model Explanation

What the authorization server protects and how each credential can be
attacked. The general model is the
[Threat Model Explanation](../../../../../docs/Security/Threat%20Model%20Explanation.md).
Every term here is defined in the
[Jargon Explanation](../../../../../slices/authorization/docs/Jargon%20Explanation.md),
which this doc assumes rather than repeats.

## Credentials, in order of power

| Credential                          | Who holds it                                    | Lifetime                        | Power                                                                         |
| ----------------------------------- | ----------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| The signing key                     | `wildflower.sqlite`, plaintext                  | Forever; never rotated          | Mint any token for this origin.                                               |
| Same-device sign-in code            | The host app, in a URL, briefly                 | 60 s, single use                | Becomes a same-device session.                                                |
| Same-device browser session         | `__Host-browser_session` on the Owner's browser | 8 h                             | `OWNER_SCOPES`: all records, all approvals, all client management.            |
| Launcher / Authorization app bearer | Page memory                                     | 15 min, refreshed under a `sid` | Owner-equivalent for data and approvals, less what its browser session lacks. |
| Paired browser session              | A paired browser                                | 24 h                            | Exactly the scopes the Owner ticked, all of `OWNER_SCOPES` unless unticked.   |
| A SMART app's access token          | The app                                         | 15 min                          | The granted resource scopes its browser session holds, on this origin only.   |
| A refresh token                     | The app, if granted `offline_access`            | Family 90 days, rotating        | New access tokens for the same grant.                                         |
| An authorization code               | The redirect                                    | 60 s, single use                | One token exchange, with the PKCE verifier.                                   |
| A pairing or request id             | The requesting page                             | 5 min                           | Polls one request's state.                                                    |

## What the server enforces

- **One verifier behind every gate.** Signature, `iss` = `aud` = the server's
  origin, `exp`, the `jti` denylist, the subject's revocation epoch and the
  session's `sid`. The `/authorization` session gate, the bearer gate in front
  of the other slices and HFS's in-process verifier all run it
  ([Origins Explanation](../../../../../docs/Origins/Explanation.md#iss-and-aud-are-the-servers-origin)).
- **Scope checks that cannot be forgotten.** A handler reaches data only
  through a capability whose construction is the check
  ([Scope-Gated Endpoints Explanation](../../../../../docs/Authorization/Scope-Gated%20Endpoints%20Explanation.md)).
- **Approvals delegate nothing the approver lacks.** Code-flow consent is
  clamped to the request; device and pairing consent are expandable only up
  to the client's registration or `OWNER_SCOPES`; every approval needs the
  approval scopes, and a client trusted on first use needs an explicit
  acknowledgment plus `Client.c` and `Client.u`.
- **Codes carry no more than the browser's session.** An authorization code
  holds its approval's resource scopes narrowed to what the session of the
  browser that made the request holds, and `wildflower/launch` only if that
  session holds it, whoever approved, fast path included
  ([Jargon Explanation](../../../../../slices/authorization/docs/Jargon%20Explanation.md#browser-session)).
  A request asking for more stops at that browser's limited page: nothing is
  issued and the Owner isn't asked until it presses Continue, and only the
  session that made the request can read, continue or cancel it. Once a
  session has pressed Continue for an app, its later requests for that app
  skip the page, unless they carry `prompt=consent`; the bound on the code
  still applies.
- **A session grows only by the Owner's approval.** From the limited page a
  browser can ask the Owner to widen its session by exactly what it lacks of
  the request; the Owner may only untick, can grant no more than they hold,
  and the session keeps its `sid` and expiry. Only that session can poll for
  the answer, and its wider token replaces the narrower one, which is
  revoked. Asking spends from the authorization start limit.
- **Codes and refresh tokens resist theft.** PKCE S256 only, constant-time
  compares, codes bound to client and redirect; refresh families rotate and a
  replay revokes the family; only hashes are stored.
- **The cookie is a bearer only from the server's own pages.** A write with
  the cookie needs the server's `Origin`; CORS never allows credentials; the
  cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`. Its value is the
  session's token, so revoking the session or the `jti` ends it.
- **Untrusted redirects never receive errors.** While a client is `new` or
  `changed`, every failure renders locally.
- **Consent pages are locked down.** `default-src 'none'`,
  `frame-ancestors 'none'`, no referrer leakage, cache suppressed.
- **Authorization starts are rate-limited** per visitor address and globally,
  deferred for a browser that can decide its own requests
  (`wildflower-server-rust`'s `authorization_start_limit.rs`).
- **Rows expire and are swept** ([Retention](./Book/Domain/Retention%20Explanation.md)).

## What the server relies on others for

- **The Owner's judgement.** Trust on first use means any page can present a
  known `client_id` with its own redirect; the prompt's redirect origin and
  acknowledgment checkbox are the mitigation.
- **The device's TLS.** The cookie's `Secure` and `__Host-` prefix, and the
  sign-in code travelling in a URL, assume the origin is only ever reached
  over the device-terminated TLS the tunnel provides.
- **The FHIR server's own authorization.** HFS checks the token again, but it
  does not enforce patient compartments (#416); `patient/` scopes read the
  whole server.
- **The host app.** It mints sign-in codes in process; whoever can run code
  in that process is the Owner.

## Threats

| Threat                                  | Outcome                                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read of `wildflower.sqlite`             | The signing key: unlimited Owner-equivalent tokens until the key is replaced. Any token with `wildflower/*.r` can download the file over `/databases`.                                  |
| Stolen Owner cookie                     | 8 hours as the Owner from any origin that can send it: only the server's pages can, but an XSS on them or a browser compromise can. Revoke the session.                                 |
| Stolen launcher bearer                  | 15 minutes Owner-equivalent; the launcher keeps it in memory only ([Auth Token Storage Explanation](../../../../../slices/authorization/docs/Auth%20Token%20Storage%20Explanation.md)). |
| Sign-in code seen in transit or history | 60-second window, spent on first use; the first presenter wins.                                                                                                                         |
| Phishing with a trusted `client_id`     | A `changed` prompt under a trusted name; the Owner must acknowledge the redirect.                                                                                                       |
| Disabled client keeps calling           | Its live access tokens work until they expire (up to 15 min); the verifier does not consult the client row. Refresh and new grants are refused.                                         |
| Revoke one grant, lose another          | Revocation is per client: it bumps the client's epoch and expires all its refresh families.                                                                                             |
| Pairing spam                            | `/oauth/pair/start` is not rate-limited and each pairing notifies the Owner.                                                                                                            |
| Request-id guessing on the wait page    | The status poll and the limited page answer only the request's own session; the code still needs the PKCE verifier.                                                                     |
| Widening-id guessing                    | The widening's poll answers only the session it widens; the Owner's card needs `wildflower/AuthorizationRequest.r`.                                                                     |
| Store read failure                      | Verification fails closed (500), never open.                                                                                                                                            |

## Not in scope here

- The relay and the visitor's address: [Relay Explanation](../../../../../docs/Relay/Explanation.md).
- Where the database file sits and who can read it on the device:
  [Host Threat Model](../../../host-app/Threat%20Model%20Explanation.md).
- `hfs_session`, the FHIR web UI's own cookie, is helios-ui's; the host only
  turns it into a bearer from the server's origin.
