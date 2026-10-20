# Grant Store

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/store.rs}}

The grant store is everything the server remembers: the apps it knows, the browsers it has let in, the requests waiting on the Owner, the codes and refresh tokens it has handed out, the Owner's standing grants, and the keys it signs with. This part is the **port**: the shape the domain asks of that memory, with no SQL in it. The [Persistence](<Persistence Explanation.md>) part is the SQLite adapter that fills it, and the [test fake](<Grant Store/Test Fake Explanation.md>) is the in-memory one every domain unit test runs against.

The port has two halves. A **scope** is one unit of store work: a run of reads and writes on one connection that, for a write, either all happen or none do. A **primitive** is one thing done to one table inside a scope: load a client, redeem a code, end a refresh family. Scopes come from [`GrantStore`](#item-GrantStore); primitives come from the handle a scope lends, [`GrantTx`](#item-GrantTx).

**One operation, one scope.** A capability method (an app exchanging a code, the Owner approving a request) opens exactly one scope, at its top. Everything beneath it, the proofs in `domain/authority/` and the writers, takes the handle the scope lends, never the store, so nothing below a capability can open a second scope and see the world change between two of its own reads. A method reads as: open the scope, run the flow inside it to an outcome value, then act on the outcome outside it.

**What acts outside the scope is a side effect**: republishing the [Owner prompt](<Domain/Owner Prompt Explanation.md>) to the host, and writing to the host's revocation store. Inside the scope, a side effect would run before the commit: a republish reads the store on another pooled connection, which would still see the rows as they stood before this scope. Signing a token isn't a side effect. It is pure computation over the [key](<Domain/Signing Key Explanation.md>) the scope loaded, so it runs inside the scope, and a signing failure rolls the scope back.

**A refusal that must keep what the scope wrote is an `Ok` outcome**, not an `Err`, since an `Err` rolls a write scope back: a presented [authorization code](<Domain/Authorization Code Explanation.md>) that fails a check stays spent, and a refused device poll stays stamped. That is why many flows return `Result<Result<T, Refusal>, AuthorizationServerError>`: the outer `Err` is "the store failed, undo everything", the inner one is "the answer is no, keep what we did".

## Two scopes in one operation

Two operations open a read scope and then a write scope, for the same reason: **each also reads or writes the revocation store, which is another connection to the same SQLite file**, and touching it while holding this store's write lock could stall both connections for the busy timeout.

- [Exchanging a refresh token](<Capabilities/OAuth/Token Exchanger Explanation.md#item-TokenExchanger--exchange_refresh_token>) validates the token in a read scope, its app's revocation epoch included. A write scope then checks the store-only facts again (the family may have ended between the two), rotates the token and mints.
- [Revoking a grant](<Capabilities/Access/Grants Explanation.md#item-GrantsRevoker--revoke>) loads the grant in a read scope to learn its app, bumps that app's revocation epoch, then deletes the grant and ends the app's refresh families in a write scope.

## `domain::grant_store::store`

### `GrantStore`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/store.rs GrantStore}}

## `domain::grant_store`

### `GrantTx`

The handle is a bundle of one trait per table, each on a page of its own, in the order the Domain part introduces the entities they hold:

- [Clients](<Grant Store/Clients Explanation.md>): the registered apps, and the switch that disables one.
- [Browser Sessions](<Grant Store/Browser Sessions Explanation.md>): the browsers the server has let in, and the apps each has gone on past its limited page for.
- [Authorization Requests](<Grant Store/Authorization Requests Explanation.md>): the requests the Owner decides, and each flow's guarded replace.
- [Launch Contexts](<Grant Store/Launch Contexts Explanation.md>): SMART `launch` values, each spent once.
- [Grants](<Grant Store/Grants Explanation.md>): the Owner's standing consent, per app and redirect or per app and device.
- [Authorization Codes](<Grant Store/Authorization Codes Explanation.md>): issued codes, each redeemed once.
- [Refresh Tokens](<Grant Store/Refresh Tokens Explanation.md>): refresh families and their rotation lineage, ended rather than deleted.
- [Signing Keys](<Grant Store/Signing Keys Explanation.md>): the keys tokens are signed and checked with.
- [Test Fake](<Grant Store/Test Fake Explanation.md>): the in-memory store, and the fixtures the crate's unit tests share.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/mod.rs GrantTx}}
