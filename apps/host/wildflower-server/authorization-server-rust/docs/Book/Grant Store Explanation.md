# Grant Store

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/store.rs}}

The grant store is everything the server remembers: the apps it knows, the browsers it has let in, the requests waiting on the Owner, the codes and refresh tokens it has handed out, the Owner's standing grants, and the keys it signs with. This part is the **port**: the shape the domain asks of that memory, with no SQL in it. The [Persistence](<Persistence Explanation.md>) part is the SQLite adapter that fills it, and [the test fake](<Grant Store/Test Fake Explanation.md>) is the in-memory one every domain unit test runs against.

The port has two halves. A **scope** is one unit of store work: a run of reads and writes on one connection that, for a write, either all happen or none do. A **primitive** is one thing done to one table inside a scope: load a client, redeem a code, end a refresh family. Scopes come from [`GrantStore`](#grantstore); primitives come from the handle a scope hands out, [`GrantTx`](#granttx).

**One operation, one scope.** A capability method (an app exchanging a code, the Owner approving a request) opens exactly one scope, at its top. Everything beneath it, the proofs in `domain/authority/` and the writers that need them, takes the handle the scope hands out, never the store, so nothing below a capability can open a second scope and see the world change between two of its own reads. A method reads as: open the scope, run the flow inside it to an outcome value, then act on the outcome outside it.

**What acts outside the scope is a side effect**: republishing the newest pending consent to the host, and writing to the revocation store's epochs. Inside the scope, a side effect would run before the commit: a republish reads the store on another pooled connection, which would still see the rows as they stood before this scope. Signing a token isn't a side effect. It is pure computation over the key the scope loaded, so it runs inside the scope, and a signing failure rolls the scope back.

## `GrantStore`

The seam a capability opens its scope through. `Tx` is the handle a scope lends its closure: a checked-out connection for the SQLite adapter, the in-memory maps for the fake.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/store.rs GrantStore}}

A scope's closure may fail with any error its flow defines, as long as an `AuthorizationServerError` converts into it. **An `Err` rolls a write scope back. A refusal that must keep what the scope wrote is an `Ok` outcome**, not an `Err`: a presented authorization code that fails a check stays spent, and a refused device poll stays stamped. That is why many flows return `Result<Result<T, Refusal>, AuthorizationServerError>`: the outer `Err` is "the store failed, undo everything", the inner one is "the answer is no, keep what we did".

## `read`

**A read scope is for an operation that only reads.** It runs in autocommit: each statement sees the store as it is at that moment, and no lock is held between statements. Showing a consent prompt, listing the Owner's grants, publishing the server's keys and verifying a session token all read this way.

The SQLite side: [`read`](<Persistence/SQLite Grant Store Explanation.md#read>).

## `write`

**A write scope is for an operation that writes, and takes the write lock before its first read.** It is one `BEGIN IMMEDIATE` transaction, so a read that decides a write sees the row the write lands on: of two apps redeeming one code, the second waits for the first and then finds the code gone. It commits when the closure returns `Ok` and rolls back when it returns `Err`.

The SQLite side: [`write`](<Persistence/SQLite Grant Store Explanation.md#write>).

## Two scopes in one operation

Two operations open a read scope and then a write scope, for the same reason: **each also reads or writes the revocation store, which is another connection to the same SQLite file**, and touching it while holding this store's write lock could stall both connections for the busy timeout.

- [Exchanging a refresh token](<Capabilities/OAuth/Token Exchanger Explanation.md#exchange_refresh_token>) validates the token in a read scope, its client's revocation epoch included. A write scope then checks the store-only facts again (the family may have ended between the two), rotates the token and mints.
- [Revoking a grant](<Capabilities/Access/Grants Explanation.md#revoke>) loads the grant in a read scope to learn its client, bumps that client's revocation epoch, then deletes the grant and ends the client's refresh families in a write scope. The bump goes first: a bump that over-revokes because the delete then failed is recoverable (a retry finds the grant and finishes), while a delete committed without its bump would leave live access tokens and a retry that answers 404.

## `GrantTx`

The handle a scope lends: every per-table primitive, one trait per table, bundled. Any type that implements every table trait is a `GrantTx`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/mod.rs GrantTx}}

**A primitive reports absence and conflict through its return type**: `Option` for "no such row", `bool` for "the guarded write didn't land", a count for a sweep. It fails only with the opaque `Infrastructure` error, for a store that can't be reached or a row that can't be read back. What an absent row or a lost race _means_ (a 404, an `invalid_grant`, a consent that is no longer there) is decided above, in the capabilities.

## The tables

One page per table trait, in the order the domain introduces the entities. Each method's section says what fact it reads or writes and what the domain relies on it keeping, and links the SQLite side that keeps it.

| Page                                                                          | What it holds                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Clients](<Grant Store/Clients Explanation.md>)                               | The registered apps, and the switch that disables one.                                      |
| [Browser Sessions](<Grant Store/Browser Sessions Explanation.md>)             | The browsers the server has let in, and which apps each has gone past the limited page for. |
| [Authorization Requests](<Grant Store/Authorization Requests Explanation.md>) | The requests the Owner decides, and the guarded replace that writes a decision once.        |
| [Launch Contexts](<Grant Store/Launch Contexts Explanation.md>)               | SMART `launch` values, each consumed once.                                                  |
| [Grants](<Grant Store/Grants Explanation.md>)                                 | The Owner's standing consent, per app and redirect or per app and device.                   |
| [Authorization Codes](<Grant Store/Authorization Codes Explanation.md>)       | Issued codes, read and deleted in one statement so each redeems once.                       |
| [Refresh Tokens](<Grant Store/Refresh Tokens Explanation.md>)                 | Refresh families and their rotation lineage, ended rather than deleted.                     |
| [Signing Keys](<Grant Store/Signing Keys Explanation.md>)                     | The keys tokens are signed and checked with.                                                |
| [Test Fake](<Grant Store/Test Fake Explanation.md>)                           | The in-memory store and the fixtures the domain's unit tests share.                         |
