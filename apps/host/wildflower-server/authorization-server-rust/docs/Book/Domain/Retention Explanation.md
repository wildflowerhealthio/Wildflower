# Retention

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs}}

Four of the server's tables only grow. Refresh-token families keep their rows after they die, so a replayed token still resolves to its dead family. A request nobody decided stays `pending` forever. A code nobody came back for is never redeemed. A revoked browser session keeps its row, so tokens minted under it can still be refused by its `sid`. None of these stale rows is live: every read already checks expiry. They only take up the Owner's disk.

**Retention deletes a row once it has been dead for its window, measured past the row's own `expires_at`** (for a browser session, its `expires_at` or `revoked_at`, whichever is first). The clock starts when the row stopped being usable, so nothing live is ever in range, and a dead row stays readable for a while as a record of what happened. [Retention Explanation](<../../Retention Explanation.md>) gives the reasoning behind each window.

The server sweeps once at startup and then daily, through {{#code-link apps/host/wildflower-server/authorization-server-rust/src/lib.rs spawn_retention_sweep}}, and logs what a sweep reclaimed whenever it reclaimed anything.

## Test fixtures

Every fixture is placed relative to one fixed instant, so the tests read no clock.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::now}}

`family` builds a refresh-token family with a given deadline, and `token` one token in a family.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::family}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::token}}

`request` builds a device-code authorization request that expires at `expires_at`, and `code` an authorization code that does.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::request}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::code}}

`session` builds an Owner browser session that expires at `expires_at`, never revoked.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::session}}

`seeded` puts one row of each kind on each side of its window: a family 91 days dead and one 89 days dead, a live family minted under the session `named`; requests and codes 8 days dead, 6 days dead, and live; sessions ended 25 hours ago, 23 hours ago, and 10 days ago (`named`).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::seeded}}

## `REFRESH_TOKEN_FAMILY_RETENTION`

A refresh-token family, with its tokens, is kept 90 days past its deadline: the same as the family's own lifetime, [`REFRESH_TOKEN_FAMILY_TTL`](<Refresh Token Explanation.md#refresh_token_family_ttl>), so a lineage stays auditable for its own lifetime again after it dies. Revoking a family pulls its deadline back to the revocation, so the window runs from the revocation.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs REFRESH_TOKEN_FAMILY_RETENTION}}

No unit test of its own; the tests under [`purge_expired`](#purge_expired) place families either side of it.

## `AUTHORIZATION_RETENTION`

An authorization request or code is kept 7 days past its expiry. Both live for minutes; a week is a generous buffer to answer what a client tried to do.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs AUTHORIZATION_RETENTION}}

No unit test of its own; the tests under [`purge_expired`](#purge_expired) place requests and codes either side of it.

## `BROWSER_SESSION_RETENTION`

A browser session is kept for the longest session's lifetime, [`LONGEST_BROWSER_SESSION_TTL`](<Browser Session Explanation.md#longest_browser_session_ttl>), once it has expired or been revoked. No token minted under the session outlives that. Past it, only a refresh-token family can still name the session, and the sweep keeps any session that a family alive at the cutoff names, so that family's refresh still finds its session.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs BROWSER_SESSION_RETENTION}}

No unit test of its own; the tests under [`purge_expired`](#purge_expired) place sessions either side of it.

## `PurgedCounts`

What one sweep reclaimed, per table. Refresh tokens are not counted separately: they go with their family.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs PurgedCounts}}

## `is_empty`

Whether the sweep reclaimed nothing. Nothing is the steady state, and the server logs a sweep only when it isn't, so an idle server writes no log lines.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs PurgedCounts::is_empty}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::a_second_pass_reclaims_nothing}}

The first sweep over the seeded store reclaims something; a second at the same instant reclaims nothing, and its counts are empty.

## `purge_expired`

Delete every row past its window as of `now`, in one write scope, and report what went. Each window becomes a cutoff (`now` minus the window), and the store deletes rows whose expiry falls before it. A failure rolls the whole sweep back. Taking `now` as an argument means the whole sweep reads one instant, and tests can place rows without sleeping.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs purge_expired}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::purges_past_each_window_and_spares_everything_inside_it}}

In each table, exactly the row past its window goes: the 91-day-dead family and its token, the 8-day-dead request and code, the session ended 25 hours ago. The rows inside their windows stay, the live ones stay, and the session ended 10 days ago stays because the live family names it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::deleting_a_family_takes_its_tokens}}

A family's tokens of every generation go with it, so no token is left pointing at a family that no longer exists.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::an_empty_database_reclaims_nothing}}

A first-ever startup sweep over an empty store reclaims nothing and does not fail.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs tests::the_spared_rows_are_reclaimed_once_they_age_out}}

Swept again 90 days later, the rows spared the first time go: the 89-day-dead family and its token, both remaining requests and codes, and both remaining sessions, including `named`, since the family that named it is no longer alive at the later cutoff. The windows run from each row's expiry, not from `now`.
