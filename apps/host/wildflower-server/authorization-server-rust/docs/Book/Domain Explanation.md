# Domain

The entities in `src/domain/` are the rules of the server, with no HTTP and no SQL in them. Each page takes one entity: what it is in the Owner's world, then its module, types and methods, each with the unit tests that hold it. The pages are in build-up order, so each concept arrives before a later page leans on it.

- [Scopes](<Domain/Scopes Explanation.md>): how the server compares scope strings, from the shared scopes slice. Every later "covers" means this.
- [Signing Key](<Domain/Signing Key Explanation.md>): the key the server signs its tokens with, and publishes for others to check them.
- [Browser Session](<Domain/Browser Session Explanation.md>): a browser the server has let in, and the scopes that cap what apps requested in it can receive.
- [Access Token](<Domain/Access Token Explanation.md>): the fifteen-minute signed token an app presents to the FHIR server.
- [Client Credentials](<Domain/Client Credentials Explanation.md>): what an app presents when it authenticates.
- [Client](<Domain/Client Explanation.md>): an app that asks for access, the registration that says what it may ask for, and what approving a request would change in it.
- [Grant](<Domain/Grant Explanation.md>): the Owner's standing yes to an app, and when it lets a request skip asking.
- [Launch Context](<Domain/Launch Context Explanation.md>): a SMART `launch` value, for one app (and maybe one patient) or for a server's launcher, spent once.
- [Authorization Request](<Domain/Authorization Request Explanation.md>): one request for access, and the guarded replace that writes its transitions.
  - [Code Request](<Domain/Authorization Request/Code Request Explanation.md>): an app's request for a code, its limited page, and its resolution against the app's registration.
  - [Polled Requests](<Domain/Authorization Request/Polled Requests Explanation.md>): a device's request and a browser's pairing, which a poll claims once.
- [Errors](<Domain/Errors Explanation.md>): the four vocabularies the server says no in.
- [Authorization Code](<Domain/Authorization Code Explanation.md>): the one-minute, single-use code that carries an approval to the app's back end, and the callback that delivers it.
- [Refresh Token](<Domain/Refresh Token Explanation.md>): the chain of refresh tokens one authorization starts.
- [Owner Prompt](<Domain/Owner Prompt Explanation.md>): which waiting request the host asks the Owner about, and the key that names one.
- [Retention](<Domain/Retention Explanation.md>): how long each accumulating table keeps a row past its expiry, and the sweep that applies it.
- [Same-Device Sign-In Codes](<Domain/Same Device Sign In Codes Explanation.md>): the codes the base signs the Owner's browser in with, and where a sign-in may go next.
- [Session Housekeeping](<Domain/Session Housekeeping Explanation.md>): logout's denylisting and the throttle on a session's `last_seen_at`.
- [Source Guards](<Domain/Source Guards Explanation.md>): the tests that hold rules about where code may be written.
- [Test Fixtures](<Domain/Test Fixtures Explanation.md>): the helpers the Domain tests share.

The capabilities, proofs and writers that put these entities to work (`domain/capabilities/`, `domain/authority/`) have chapters of their own, after the [Grant Store](<Grant Store Explanation.md>).
