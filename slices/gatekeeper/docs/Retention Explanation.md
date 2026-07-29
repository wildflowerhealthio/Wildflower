# Retention Explanation

Why the gatekeeper deletes rows on a timer, why the windows are 90 days and 7 days, and why they are measured past `expires_at` rather than from `now`.

The policy lives in `gatekeeper-rust/src/domain/retention.rs`; the timer that applies it is `spawn_retention_sweep` in that crate's `lib.rs`.

## The problem: three tables that only grow

Most of the gatekeeper's tables are self-limiting — a grant is deleted when it is revoked, an authorization code is deleted the moment it is redeemed. Three are not:

- **`refresh_token_families` / `refresh_tokens`.** Rotation appends one token row per generation, and revocation deliberately does **not** delete: it pulls the family's `expires_at` back to the revocation instant and stamps the live token consumed. Keeping the rows is what lets a replayed token still resolve to its (now dead) family, which is how reuse detection knows to revoke a lineage rather than shrug at an unknown hash. Soft revocation is correct — it just has no end.
- **`authorization_requests`.** Nothing transitions a request the user simply walked away from. The flows write terminal statuses on approve, deny, and redemption; an abandoned `pending` row stays `pending` forever.
- **`authorization_codes`.** Redemption deletes the row, so only codes nobody came back for accumulate.

None of this is a _correctness_ problem — every read path already filters on `expires_at`, so a stale row is inert. It is a storage problem, and on a single-user desktop app storage is the user's disk.

## The shape of the fix: a window, not `expires_at < now`

The naive sweep is `DELETE WHERE expires_at < now`. It reclaims the most and is the wrong tool, because these rows have audit value _after_ they stop being usable. "Why did that device lose access on Tuesday?" is answerable only if Tuesday's lineage is still there. A `now` cutoff destroys the record at exactly the moment it becomes purely historical — that is, at the moment it becomes evidence rather than state.

So each window is measured **past the row's own `expires_at`**: the retention clock starts when the row stopped being usable, not when it was created. Two consequences fall out for free:

- **Nothing live is ever in range.** A live refresh-token family has `expires_at` in the future; a cutoff of `now − 90 days` is not merely outside its window but on the far side of `now` twice over. The sweep cannot delete something in use even if the windows were misconfigured to zero.
- **A revoked family gets a full window too.** Revocation pulls `expires_at` back to the revocation instant, so the clock starts at the revocation — the reuse-detection case, the one most worth auditing, is retained 90 days from the event rather than from a deadline it never reached.

## The windows

| Rows                                              | Window past `expires_at` | Why                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refresh_token_families` + their `refresh_tokens` | 90 days                  | Matches `REFRESH_TOKEN_FAMILY_TTL`, the family's own absolute lifetime. A family that runs its full course is readable for roughly twice its lifetime — a quarter of history, which is the horizon over which "what happened to this device's session" is still a live question. |
| `authorization_requests`, `authorization_codes`   | 7 days                   | Both are minute-scale objects (a 5-minute request TTL, a shorter code TTL). A week is a generous buffer over a very short useful life: long enough to answer "what did that client try to do last Tuesday", short enough that abandoned flows can't pile up.                     |

The refresh-token window deletes families **and** the token rows descended from them, children first — `PRAGMA foreign_keys = ON` is set on every pooled connection, so the order is load-bearing rather than stylistic. Leaving orphaned tokens would be worse than leaving everything: an orphan reads as "unknown token", which is precisely the answer that makes replay detection do nothing.

## The trigger: startup, then daily

`setup_gatekeeper` spawns the sweep on a `tokio` interval whose first tick is immediate — one sweep at startup, then one a day. This is the same shape as the neighbouring revocation-denylist purge, and the reason is the same: the desktop app has no cron and shouldn't need one. Daily is far finer than the coarsest window it enforces, so a row is never retained meaningfully longer than the policy says, and a machine that is switched off for a month sweeps once on the next boot rather than replaying a month of missed ticks (`MissedTickBehavior::Delay`).

The three deletes run in one transaction, so a failure rolls back to the pre-sweep set rather than leaving a half-swept database; the sweep logs and retries on the next tick.

## Why the insert-path prune shrank

`insert_authorization_request` used to delete **every** expired request before inserting — a 0-day retention that ran on each `/authorize` and `/oauth/device_authorization`. That predates the sweep and is incompatible with any window at all: rows were gone long before a daily tick could apply a 7-day policy.

What remains there is the narrow half the sweep can't cover. An expired request still sitting at `status = 'pending'` under the same `user_code` occupies the partial unique index (`WHERE status = 'pending' AND user_code IS NOT NULL`), so a colliding insert is a hard error — and the stale row may be up to a sweep interval away from being reclaimed. The insert therefore clears exactly that: rows matching **this** request's `user_code` that are **already expired**. A code-flow request (no `user_code`) skips it entirely, and a collision with a _live_ pending request stays a hard error, as it always was — a live request is never silently dropped to make room for a new one.

## Related

- [Jargon Explanation](./Jargon%20Explanation.md) — families, lineage, rotation, reuse detection
- `gatekeeper-rust/src/domain/refresh_token.rs` — `REFRESH_TOKEN_FAMILY_TTL` and the rotation semantics the 90-day window mirrors
