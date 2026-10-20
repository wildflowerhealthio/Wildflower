# Authority

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/mod.rs}}

Every row that hands out access is written on some authority. Approving a request, issuing a code, recording or widening a grant, widening an app's registration, starting a browser session, minting a token: each happens because someone was entitled to cause it. An **authority proof** is that entitlement as a value. **A privileged write takes a proof as its argument, so it can't happen without one.**

A proof has private fields and **one constructor, which is the check for the rule it stands for**. There is no other way to build one, so holding the value is the evidence that the check ran. The constructors that read the store take the calling capability's open scope from the [Grant Store](<Grant Store Explanation.md>), so the proof is checked against the same rows the operation then writes, under the same lock.

That makes the audit **two short lists**: the constructors on these pages, and the [writers](<Writers Explanation.md>), the one place a privileged store call may appear. A source guard in the writers' module fails when a privileged store method is called anywhere else in production code, so a new flow can't reach around a writer and the proof it demands.

Where a writer accepts more than one kind of proof, the set is an **enum, not a trait**: [`TokenEntitlement`](<Authority/Token Entitlement Explanation.md>) for the access-token minter, [`GrantRedemption`](<Authority/Redemption Explanation.md>) for the refresh-family writer, and the request approver's `CodeAuthority`. A closed list in one place is what an audit reads, and a new source of authority has to be added to it by name.

Some writes need no proof. The request transitions that grant nothing (parking a request, stamping a poll, denying, raising a request for the Owner, the limited page's Continue and Cancel) go through the [guarded replace](<Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>). Whether the Owner acknowledged a change to an app's registration is a consent-card rule, checked before anything is written.

The pages, in the order the proofs build on each other:

- [Authenticated Client](<Authority/Authenticated Client Explanation.md>): the app exists, is enabled, and, if it keeps a secret, presented it. Anything an app does on its own behalf takes one.
- [Delegated Scopes](<Authority/Delegated Scopes Explanation.md>): an approver passes on only what the prompt may grant and what it holds itself, and holds the power to create what approving creates. A code carries only what the requesting browser also holds.
- [Standing Grant](<Authority/Standing Grant Explanation.md>): a standing grant already covers every scope of a request that changes nothing in the app's registration, so `/oauth/authorize` may issue a code with nobody asked.
- [Redemption](<Authority/Redemption Explanation.md>): a code, an approved device request or a refresh token was redeemed at `/oauth/token` by the app it belongs to; the token carries what the record behind it recorded.
- [Same-Device Sign-In](<Authority/Same Device Sign In Explanation.md>): a sign-in code the base minted was presented once and in time, so the browser is on the server's own device and is the Owner's.
- [Browser Pairing](<Authority/Browser Pairing Explanation.md>): a pairing the Owner approved was claimed, once, by the page that started it, so that browser gets a session with what the Owner granted.
- [Token Entitlement](<Authority/Token Entitlement Explanation.md>): the closed list of proofs a token may be minted under, each carrying the token's claims.
- [Test Fixtures](<Authority/Test Fixtures Explanation.md>): the helpers the Authority tests share.
