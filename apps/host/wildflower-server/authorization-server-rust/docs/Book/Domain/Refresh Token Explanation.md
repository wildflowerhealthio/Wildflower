# Refresh Token

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs}}

An access token lasts minutes. An app the Owner allowed `offline_access` also gets a refresh token, which it trades at `/oauth/token` for a new access token, and a new refresh token, without asking anyone again. The first refresh token comes from redeeming an [authorization code](<Authorization Code Explanation.md>) or from a device's successful poll; every later one replaces the one before it.

That chain is a **refresh family**: every refresh token descended from one redemption. The family holds what they all share (the app, the scopes, the patient, the browser session, the deadline), and each token in it is one link. **Only the newest link works. Presenting an older one kills the whole family**, because a link presented twice means either a copy is loose or the app is broken, and either way the chain can't be trusted. The app then has to run the authorization flow again.

## `RefreshTokenFamily`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshTokenFamily}}

| Field                     | The fact it records                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_id`               | The app. Only it may refresh.                                                                                                                             |
| `scopes`, `patient`       | What every access token minted from the family carries, copied from the redemption that started it.                                                       |
| `issued_at`               | The redemption. Revoking the app refuses every family begun before that moment.                                                                           |
| `expires_at`              | The deadline for the whole family (see [`REFRESH_TOKEN_FAMILY_TTL`](#refresh_token_family_ttl)). Revoking the family sets it to the moment of revocation. |
| `authorization_code_hash` | The hash of the code that started it, so a replay of that code can find and end it. None for a device.                                                    |
| `grant_id`                | The [grant](<Grant Explanation.md>) behind the redemption, when one was found. Recorded; nothing reads it.                                                |
| `sid`                     | The browser session the code was issued under. **Refresh is refused once that session is revoked.** None for a device.                                    |

A family is never deleted when it ends. Ending it moves its deadline to now and spends its live token, so the chain stays readable after the fact; the retention sweep removes it later.

## `RefreshToken`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshToken}}

One link. The server keeps only a hash of it; the app is the only holder of the token itself. `consumed_at` is empty on exactly one link per live family, the newest, and set on every link that has been traded in.

## `REFRESH_TOKEN_FAMILY_TTL`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs REFRESH_TOKEN_FAMILY_TTL}}

**A family lasts 90 days from the redemption that started it, however often it is refreshed.** Each link is good until the family's deadline; refreshing never moves it. Set by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::start_family}}. No unit test of its own.

## `RefreshTokenConsumeOutcome`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs RefreshTokenConsumeOutcome}}

Trading in a link has three outcomes, and they mean different things. `Consumed`: the link was the newest, and is spent now. `Replayed`: the link exists but was already spent, which is the theft signal. `NotFound`: no such link at all, which is a bad token, not a theft, so nothing is revoked. Ignoring the outcome is a compile warning, since dropping a `Replayed` would skip the revocation.

## Test fixtures

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs tests::live_token}}

A family with one live link, under the given hash.

## `consume_refresh_token`

Spending a link. It is spent only if it is still live, and in the same write scope a miss is told apart into "already spent" and "never existed". Two redemptions of the same link at once can't both win: one spends it, the other sees it spent.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs consume_refresh_token}}

The writer that rotates the family acts on the answer. A win inserts the next link; a replay ends the family before refusing:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::rotate from="RefreshTokenConsumeOutcome::Replayed" through="self.tx.expire_refresh_token_family"}}

Before it gets there, a presented link is refused outright if its family belongs to another app, has passed its deadline (which covers a family already ended), was minted under a revoked browser session, or was begun before the app's tokens were revoked ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}).

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/refresh_token.rs tests::consume_reports_consumed_then_replayed_then_not_found}}

The first trade of a live link spends it, the second is a replay, and a hash that was never issued is not found.
