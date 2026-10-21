# OAuth

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/mod.rs}}

The OAuth capabilities are the server's **front door**: the `/oauth/*` surface an app, a browser or a device reaches before anyone holds a token. The [Access](<Access Explanation.md>) capabilities open for a caller whose scopes cover them. Nobody arriving here has scopes yet, so these doors open on something else: the app's own credentials, the browser session a request was made in, a secret only one page holds, or nothing at all.

**Each capability does one job, and holding it lets a handler do nothing else with the store.** The `/oauth/authorize` handler holds a starter that can start and continue a request. It can't read a grant or mint a token. Inside, each operation opens one store scope and composes the [authority proofs](<../Authority Explanation.md>) and [writers](<../Writers Explanation.md>) beneath it, where the privileged writes live.

| What opens the door      | Who is at it                                                                  | Capabilities                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client               | An app's back end or a device, authenticating as its OAuth client             | [Client Authenticator](<OAuth/Client Authenticator Explanation.md>) checks the credentials and yields the proof that [Device Authorizer](<OAuth/Device Authorizer Explanation.md>), [Token Exchanger](<OAuth/Token Exchanger Explanation.md>) and [Client Token Revoker](<OAuth/Client Token Revoker Explanation.md>) take |
| Nobody                   | A browser at `/oauth/authorize`, a wait page polling, anyone reading the JWKS | [Code Authorization Starter](<OAuth/Code Authorization Starter Explanation.md>), [Authorization Status Reader](<OAuth/Authorization Status Reader Explanation.md>), [Public Keys Reader](<OAuth/Public Keys Reader Explanation.md>)                                                                                        |
| In-process               | The host and the apps slice, launching an app                                 | [Launch Contexts](<OAuth/Launch Contexts Explanation.md>) mints the SMART `launch` value; the starter consumes it                                                                                                                                                                                                          |
| A code minted in-process | The Owner's browser, signing in on the same device                            | [Same-Device Sign-In](<OAuth/Same Device Sign In Explanation.md>) redeems it; [Same-Device Session Ender](<OAuth/Same Device Session Ender Explanation.md>) ends the session it started                                                                                                                                    |
| The browser session      | The browser that made a request, on its limited page                          | [Session Shortfall](<OAuth/Session Shortfall Explanation.md>) reads and cancels; the starter continues                                                                                                                                                                                                                     |
| A pairing code           | A browser that isn't the Owner's, asking to be paired                         | [Browser Pairing](<OAuth/Browser Pairing Explanation.md>)                                                                                                                                                                                                                                                                  |

"Nobody" doesn't mean unchecked. The starter answers any browser that holds a browser session, but it only parks a request: a code comes from the Owner's decision or from a standing grant, never from the request alone. The status reader answers the browser session that made the request, or one holding the scopes to decide any request, so a leaked request id collects nothing.

## In this part

- [Launch Contexts](<OAuth/Launch Contexts Explanation.md>): minting SMART `launch` values, and consuming one once.
- [Code Authorization Starter](<OAuth/Code Authorization Starter Explanation.md>): `/oauth/authorize`. Validates an app's request, parks it, and sends the browser to its limited page, the consent card, the wait page, or straight back to the app with a code.
- [Authorization Status Reader](<OAuth/Authorization Status Reader Explanation.md>): the wait page's poll of a parked request.
- [Session Shortfall](<OAuth/Session Shortfall Explanation.md>): the limited page's read and Cancel, for a request asking more than its browser session holds.
- [Client Authenticator](<OAuth/Client Authenticator Explanation.md>): checking a client's credentials, yielding the proof the client-gated capabilities take.
- [Device Authorizer](<OAuth/Device Authorizer Explanation.md>): `/oauth/device_authorization`, parking a device's request for the Owner.
- [Browser Pairing](<OAuth/Browser Pairing Explanation.md>): giving a browser that isn't the Owner's a paired session, once the Owner approves.
- [Same-Device Sign-In](<OAuth/Same Device Sign In Explanation.md>): redeeming the one-time code the base mints to sign the Owner's browser in.
- [Same-Device Session Ender](<OAuth/Same Device Session Ender Explanation.md>): ending the Owner session a launch's code started, when its view closes, and every one, when the server starts.
- [Token Exchanger](<OAuth/Token Exchanger Explanation.md>): `/oauth/token`, redeeming a code, a device code or a refresh token for tokens.
- [Client Token Revoker](<OAuth/Client Token Revoker Explanation.md>): `/oauth/revoke`, a client ending one of its own tokens.
- [Public Keys Reader](<OAuth/Public Keys Reader Explanation.md>): the JWKS, the public halves of the signing keys.
