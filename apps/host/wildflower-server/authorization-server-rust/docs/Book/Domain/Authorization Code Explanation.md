# Authorization Code

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_code.rs}}

An authorization code carries the Owner's approval from the browser to the app's back end. The browser is sent back to the app's redirect URI with the code in the URL; the app's back end then trades the code at `/oauth/token` for tokens. The URL holds only the code, never a token, and the code is worth nothing to anyone who sees it without the app's PKCE verifier.

**A code lives 60 seconds and is redeemed once.** It is issued in one place, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code}}, on either authority (the Owner's approval or a standing grant), which sets its expiry from the constant below.

## `IssuedAuthorizationCode`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_code.rs IssuedAuthorizationCode}}

Everything the redemption checks is fixed on the code when it is issued:

| Field                       | The fact it records                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_id`                | The [authorization request](<Authorization Request Explanation.md>) the code answers.                                                                                |
| `client_id`, `redirect_uri` | Who may redeem it, and the redirect they must name again at `/oauth/token`.                                                                                          |
| `code_challenge`            | The PKCE challenge from `/oauth/authorize`. The redeemer must present the verifier that hashes to it.                                                                |
| `granted_scopes`            | What the tokens will carry: the approval, bounded by what the requesting browser's session holds.                                                                    |
| `patient`                   | The SMART patient the approval named, if any.                                                                                                                        |
| `sid`                       | **The browser session the request was made in**, not the approver's. The tokens and refresh family the code earns record it too, so revoking that browser ends them. |

## `AUTHORIZATION_CODE_TTL`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_code.rs AUTHORIZATION_CODE_TTL}}

A code's `expires_at` is its issue instant plus this. Redemption refuses a code whose `expires_at` is before the moment of redemption. No unit test of its own; [`auth_code_grant_expired_code_rejected`](<../Integration Tests/Grant Flows Explanation.md#auth_code_grant_expired_code_rejected>) redeems a code past its expiry.

## Redeemed once

Redemption reads and deletes the code in one statement, so of two redemptions of the same code only one gets it back. The other sees nothing, just as for a code that was never issued:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem from="// A concurrent redemption" through="let Some(code)"}}

**A code presented a second time ends what the first redemption started.** The refresh family a redemption begins records a hash of its code, and a code that comes back unknown expires every family carrying that hash before the refusal. A code stolen and replayed after the app redeemed it therefore takes the app's refresh token down with it; the app re-runs the flow. A code that never existed matches no family, and the refusal is the same `invalid_grant` either way.

A request too malformed to check (a verifier of the wrong length, a redirect that isn't a URL) is refused before the code is touched. Past that, the code is spent whatever happens next: a redemption that names the wrong app or redirect, arrives late, or fails PKCE has already deleted it. [`auth_code_grant_replay_rejected`](<../Integration Tests/Grant Flows Explanation.md#auth_code_grant_replay_rejected>) and [`auth_code_replay_revokes_issued_refresh_family`](<../Integration Tests/Grant Flows Explanation.md#auth_code_replay_revokes_issued_refresh_family>) hold the server to both rules.
