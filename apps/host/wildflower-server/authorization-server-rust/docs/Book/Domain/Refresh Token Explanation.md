# Refresh Token

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs}}

An [access token](<Access Token Explanation.md>) lasts minutes. An app the Owner allowed `offline_access` also gets a refresh token, which it trades at `/oauth/token` for a new access token, and a new refresh token, without asking anyone again. The first refresh token comes from redeeming an [authorization code](<Authorization Code Explanation.md>) or from a device's successful poll; every later one replaces the one before it.

That chain is a **refresh family**: every refresh token descended from one redemption. The family holds what they all share (the app, the scopes, the patient, the browser session, the deadline), and each token in it is one link. **Only the newest link works. Presenting an older one kills the whole family**, because a link presented twice means either a copy is loose or the app is broken, and either way the chain can't be trusted. The app then has to run the authorization flow again.

**A family is never deleted when it ends.** Ending it moves its deadline to now and spends its live link, so the chain stays readable after the fact, and a replayed link still finds its dead family rather than reading as unknown. The [retention sweep](<Retention Explanation.md>) removes it later.

Before a presented link is spent, it is refused outright if its family belongs to another app, has passed its deadline (which covers a family already ended), was minted under a revoked [browser session](<Browser Session Explanation.md>), or was begun before the app's tokens were revoked ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}).

## `domain::refresh_token`

### `RefreshTokenFamily`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshTokenFamily}}

### `RefreshToken`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshToken}}

### `REFRESH_TOKEN_FAMILY_TTL`

Set on a new family by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::start_family}}.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs REFRESH_TOKEN_FAMILY_TTL}}

### `RefreshTokenConsumeOutcome`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshTokenConsumeOutcome}}

### `consume_refresh_token`

The test plants a family with one live link through the in-memory [test fake](<../Grant Store/Test Fake Explanation.md>) ([fixture](<Test Fixtures Explanation.md#refresh-token>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs consume_refresh_token tests="tests::consume_reports_consumed_then_replayed_then_not_found"}}

The writer that rotates the family acts on the answer: a win inserts the next link, and a replay ends the family before refusing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::rotate from="RefreshTokenConsumeOutcome::Replayed" through="self.tx.expire_refresh_token_family"}}
