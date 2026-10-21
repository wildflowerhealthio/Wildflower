# Refresh Token

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs}}

An [access token](<Access Token Explanation.md>) lasts minutes. An app the Owner allowed `offline_access` also gets a refresh token, which it trades at `/oauth/token` for a new access token, and a new refresh token, without asking anyone again. The first refresh token comes from redeeming an [authorization code](<Authorization Code Explanation.md>) or from a device's successful poll; every later one replaces the one before it.

That chain is a **refresh family**: every refresh token descended from one redemption. The family holds what they all share (the app, the scopes, the patient, the browser session, the deadline), and each token in it is one link. How long a family lasts is its app's [refresh policy](<Client Explanation.md#item-RefreshPolicy>): an idle limit from the family's last rotation, a maximum lifetime from its issue, and whether it ends when its browser session expires. No family outlasts the 365-day ceiling. The family's deadline is the earliest of those limits as of its last rotation, so each rotation moves it. **Only the newest link works. Presenting an older one kills the whole family**, because a link presented twice means either a copy is loose or the app is broken, and either way the chain can't be trusted. The app then has to run the authorization flow again.

**A family is never deleted when it ends.** Ending it moves its deadline to now and spends its live link, so the chain stays readable after the fact, and a replayed link still finds its dead family rather than reading as unknown. The [retention sweep](<Retention Explanation.md>) removes it later.

Before a presented link is spent, it is refused outright if its family belongs to another app, has passed its deadline (which covers a family already ended), was minted under a revoked [browser session](<Browser Session Explanation.md>), is past a limit of its app's policy as the policy stands now, or was begun before the app's tokens were revoked ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}). A tightened policy so ends a family on its next refresh, and a loosened one moves its deadline out when it next rotates, but never revives a family already past its deadline. The idle limit runs from the live link's issue, so an older, spent link isn't refused as idle: it goes on to rotation, which sees the replay and ends the family.

## `domain::refresh_token`

### `RefreshTokenFamily`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshTokenFamily}}

### `RefreshToken`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshToken}}

### `REFRESH_TOKEN_FAMILY_CEILING`

Caps the deadline {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/client/refresh_policy.rs RefreshPolicy::family_deadline}} gives a family, whatever its app's policy.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs REFRESH_TOKEN_FAMILY_CEILING}}

### `RefreshTokenConsumeOutcome`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshTokenConsumeOutcome}}

### `consume_refresh_token`

The test plants a family with one live link through the in-memory [test fake](<../Grant Store/Test Fake Explanation.md>) ([fixture](<Test Fixtures Explanation.md#refresh-token>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs consume_refresh_token tests="tests::consume_reports_consumed_then_replayed_then_not_found"}}

The writer that rotates the family acts on the answer: a win inserts the next link, and a replay ends the family before refusing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::rotate from="RefreshTokenConsumeOutcome::Replayed" through="self.tx.expire_refresh_token_family"}}
