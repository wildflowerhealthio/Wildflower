---
name: backlog-grooming
description: Groom an in-progress/backlog GitHub issue until an agent could implement it solo. Reads the repo + neighbour tickets, maps dependencies, dedups/splits, asks the human the design-only questions, then rewrites the issue to the gold-standard template and applies ripple edits. For items already in In Progress / Backlog — NOT raw intake/un-statused items (that is a separate promote protocol).
---

> **⚠️ Scope:** Backlog grooming of items already triaged into **In Progress / Backlog**. It does **NOT** cover sweeping the **Intake / un-statused** column to refine and promote items — that is a distinct protocol.

**🏅 Main objective:** leave each ticket **designed enough that an agent can work from it without the maintainer's support.** Along the way: make dependencies explicit, flag what can start independently, propose splits/nesting, set a useful-enough priority, and prune duplicates or already-solved work.

The maintainer "just fires tickets" — most arrive as a sentence. Grooming turns a fired sentence into a spec by **reading the repo and asking the human the questions only they can answer.**

---

## Repo facts (load-bearing)

- **Repo:** `assessment-is/wildflower`. All GitHub access is via the `mcp__github__*` REST tools.
- **🚫 The ProjectsV2 board is NOT readable here.** Org project boards are GraphQL-only, and the agent proxy returns `403 "GraphQL proxying is not enabled."` So **board Status / columns / iteration / ordering are invisible** in web sessions. REST (issues, labels, the priority custom field) works.
- **Priority field:** surfaces via `issue_read` / `list_issues` as `field_values: [{field:"", value:"Low|Medium|High|Urgent"}]` (the field *name* comes back blank over REST).
- **Status-proxy labels seen in use:** `🗓️ on-deck`, `🗓️ backlog`, `👀 needs human`, `📠 needs machine`, `👋 low context`, `improvement`, `fundementals`.
- **Gold-standard groomed tickets** to imitate: **#242** and **#218** (both "drafted from a design session" — full Motivation / Scope checklist / Key files / Dependencies / Out-of-scope / Tests / Verification). **#256** is a worked grooming example produced by this skill.

---

## Step 0 — Select the working set

Because board Status is unreadable here, pick what to groom one of three ways (prefer the first that's available):

1. **The human names the ticket(s).** Best signal — just groom those.
2. **REST proxy for Status.** `list_issues` (owner `assessment-is`, repo `wildflower`) → filter `state: OPEN`, then rank by the **priority** field and **status-proxy labels** above. Treat a ticket with a priority value + an `🗓️` label as triaged/backlog; treat a bare ticket (no priority, no status label) as likely **intake → skip it** (out of scope). **Confirm the grouping with the human before grooming.**
3. **Real Status via CI.** If reliable Status is needed, a GitHub **Action** can run the ProjectsV2 GraphQL query (GraphQL works on Actions runners) and commit a `board.json` the session reads. Document/propose this rather than guessing.

**✅ Do** state which selection method you used. **🚫 Don't** silently groom an intake/un-statused item as if it were backlog.

> `list_issues` returns a large payload — parse it in a subagent (it gets saved to a tool-results file) rather than loading it all into context.

---

## Step 1 — Groom one ticket (the loop)

For each ticket:

1. **Read it fully** — body + `issue_read get_comments` + linked design assets. **⚠️ `claude.ai/design` links are NOT openable from here** — flag them to the human and ask for the content or treat the dependency ticket as the source of truth.
2. **Read the repo** — locate every file/area the ticket touches. Separate **exists/reuse** (precedents to mirror, reusable components) from **genuinely new**. This is what makes a ticket solo-workable. Use a read-only `Explore` subagent for breadth; report exact `path:line`.
3. **Read the neighbours** — linked, sibling, **and closed-precedent** tickets. (Dedups and the right split usually only appear once you've read the siblings — e.g. #256's overlap with #134 surfaced only after reading #134 and the closed #95.)
4. **Map dependencies** — write them explicitly as `Blocked by #X` / `Builds on #Y` / `Sibling of #Z`, naming the **done** precedent that establishes the pattern.
5. **Dedup & size** — Is it a duplicate or partial-overlap of another ticket? Too big / multiple concerns for one agent-PR? Propose **merge / split / nest**. This is a **human call** — present options, don't decide unilaterally.
6. **Ask the human the design-only questions** via `AskUserQuestion` — the decisions only they can make (intent, scope boundary, UX, which interpretation). **Iterate.** Per `CLAUDE.md`: if you're guessing, ask. Split large batches across multiple asks.
7. **Draft** the groomed ticket in the template below. Mark inferred points as **"to confirm"** rather than guessing them into fact.
8. **Set priority + independent-start flag** — keep/adjust priority; state plainly whether it can **start now** or is **blocked** (and by what), with a suggested order.
9. **Apply on approval** (Step 2).

---

## The "ready" bar (acceptance criteria for a groomed ticket)

A ticket is groomed when **all** hold:

- ✅ An agent could implement it **solo, without more design input**.
- ✅ Dependencies are **explicit** (Blocked by / Builds on / Sibling of).
- ✅ Scope is **bounded** — an explicit **Out of scope** list.
- ✅ **Key files** named.
- ✅ **Tests + Verification** specified (per repo standards — see template).
- ✅ **Priority** set and **independent-start** status known.

Reference for "done": **#242 / #218.**

---

## Gold-standard ticket template

```md
## Context / Motivation
<why this exists; the user-visible problem; one paragraph>

## Dependencies
- Blocked by #N — <what it provides; can/can't start until it lands>
- Builds on #M (done) — <precedent/plumbing to reuse>
- Sibling of #K — <how they divide; coordinate on …>

## Scope (this ticket)
- [ ] <bounded, checkable units of work>

## Key files
- `path/to/file.ts` — <what changes / what to mirror>   (confirm uncertain paths at impl)

## Out of scope
- <explicitly excluded; → which ticket owns it>

## Key decisions / to confirm
- <decisions baked in; design notes; anything inferred, marked "to confirm">

## Tests (changes MUST include tests — see CLAUDE.md)
- <cases>; use `vite-plus/test` + fast-check per docs/Testing; `cargo test` for Rust crates.

## Verification
- `vp check`, `vp test`; `vp run ready` pre-PR; manual E2E if user-facing.

## Priority / start
- <Low|Medium|High|Urgent>. <Independently startable, or blocked by #N>. Suggested order: …
```

**✅ Do** respect repo layering, type-safety (no `any`/`@ts-ignore`/unsafe casts), and the test/doc rules from `CLAUDE.md` when writing scope and key-files.
**🚫 Don't** include any model identifier in issue titles/bodies/comments.

---

## Step 2 — Apply (after the human approves the draft)

Default to **draft-in-chat → confirm → apply**. Don't write to live issues without an explicit go-ahead.

- **Rewrite the issue:** `issue_write` `method:update` — `title`, `body`, `labels` (note: `labels` **replaces** the set; re-send any to keep), and the priority via `issue_fields` (`field_name:"Priority"`, `field_option_name:"High"`). Don't pass `assignees` unless changing them (omitting leaves them intact).
- **Ripple edits** — grooming one ticket usually touches neighbours. Post a short `add_issue_comment` on each affected sibling/blocker (e.g. "split by surface with #256", "blocker for #256"). Prefer a comment over rewriting another ticket's carefully-authored body.
- **Pruning** — if a ticket is a duplicate or already solved, recommend closing and (with approval) `issue_write` `state:closed` with `state_reason` (`duplicate` + `duplicate_of`, or `not_planned`/`completed`).

---

## Anti-patterns

- 🚫 Reporting the board as readable, or guessing Status, instead of using Step 0.
- 🚫 Grooming from the ticket text alone — without reading the repo or the sibling/closed tickets.
- 🚫 Resolving a design/dedup/split judgment call silently — surface it to the human.
- 🚫 Writing to live issues before the draft is approved.
- 🚫 Marking a ticket "ready" while it still fails the ready bar.
