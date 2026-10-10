---
name: priorities
description: What should the machine work on next? Lists the PRs and issues assigned to ruths-machine and what each one needs (answer a review, or review with /code-review high --comment), flips stacked draft PRs to ready once their base merges, then suggests backlog items from the epics that are unblocked, highest priority first, then easy. Lists first, then offers to run the picks.
---

> **⚠️ Scope:** Wildflower only (`wildflowerhealthio/Wildflower`). **List, then offer to run.** Don't comment, review, push, mark PRs ready or change assignees until the user picks items in Step 5.

**🏅 Main objective:** one short report, in order: **what's assigned to the machine**, **which stacked PRs are ready to flip**, and **the best backlog picks**. Each item gets a stated next action. Then the user picks what to run.

---

## Conventions (load-bearing)

The repos are public, so CI runs on draft PRs too. Draft and assignment carry these meanings:

- **Draft = not for reviewer reading.** A draft PR has a missing dependency or sits in a PR stack above an unmerged base. **Ready = review it now.**
- **Stacks: bottom ready, the rest draft.** Only the PR whose base is `main`, with no open blockers, is ready. The PRs above it stay draft. When a base merges, the next PR is flipped to ready and assigned to `ruthmarks151`.
- **Assigning `ruthmarks151`** (the human) to a PR asks her to review it. Every ready PR the machine opens gets that assignment.
- **Assigning `ruths-machine`** (the machine account `gh` is logged in as) to a PR asks the machine to act on it:
  - **She reviewed it recently** (a `ruthmarks151` review submitted after the PR's head commit) → address that review's comments.
  - **No such review** → review it with `/code-review high --comment <PR#>`.
- **When the machine finishes an assigned PR**, it removes `ruths-machine` from the assignees and adds `ruthmarks151`.

---

## Repo facts

- **`gh` is logged in as `ruths-machine`** with `repo` scope, and often **not `read:project`**, so the project board may be unreadable. The **epics** are the source of truth for the backlog.
- **Epics** are open issues titled `Epic: …`. Each has an `## Issues` table, one row per child: `| #N | <code>: <title> | <depends-on, e.g. 1E #574, 2F #773, or —> |`. A struck-through row (`~~#763~~`) is folded or closed. Many epics also carry a `PR stack:` line (`main ← #767 (2E) ← #768 (2A) ← …`) and a decision log that can reorder work. Read the prose under the table too.
- **Child issues** open with `Part of #<epic>.`, often followed by `Stacked on #<dep>.`. Their bodies follow the backlog-grooming template (`## Dependencies`, `## Scope` checklist, `## Key files`, `## Key decisions / to confirm`).
- **PRs name their issue in the title**, e.g. `synthetic-data-core: … (#793)`.
- **Priority** is the org-level `Priority` issue field, readable with `repo` scope. Its values follow FHIR's `request-priority` codes, from highest to lowest:

  | Priority | Definition (FHIR `request-priority`) | When to do it |
  |---|---|---|
  | **STAT** | The request should be actioned immediately - highest possible priority.  E.g. an emergency. | Work off-hours to complete it. |
  | **ASAP** | The request should be actioned as soon as possible - higher priority than urgent. | Drop any other task to complete it. |
  | **Urgent** | The request should be actioned promptly - higher priority than routine. | Begin it before any routine task. |
  | **Routine** | The request has normal priority. | Complete it as scheduled. |

  A child issue with no priority of its own takes its epic's. An issue with neither counts as Routine.
- **Ticket labels:** `🎟️ intake` (not refined), `🎟️ Accepted` (on the board), `🎟️ drifted` (refresh before work), `👀 needs human`, `📠 needs machine`.

> The epic bodies and issue lists are large. Parse them in a subagent and have it return a compact table, rather than loading them all into context.

---

## Step 1 — Machine assignments

```bash
gh pr list --assignee ruths-machine --state open --json number,title,url,author,isDraft,headRefName,baseRefName,updatedAt
gh issue list --assignee ruths-machine --state open --json number,title,url,labels
```

For each **PR**, decide the action:

1. Get the head commit time: `gh pr view <N> --json commits -q '.commits[-1].committedDate'`.
2. Get her latest review: `gh api repos/wildflowerhealthio/Wildflower/pulls/<N>/reviews -q '[.[] | select(.user.login=="ruthmarks151")] | last'`.
3. If that review was submitted **after** the head commit → **Answer review**. In scope: every comment in that review on an unresolved thread. Her own comments are the go signal and need no reaction. Also include any machine comments she reacted to, per `/answer`.
4. Otherwise → **Review** with `/code-review high --comment <N>`.

Each **issue** assigned to the machine → **Implement**. It leads the backlog list in Step 3.

---

## Step 2 — Stack upkeep

Find draft PRs by `ruths-machine` that are now the bottom of their stack:

```bash
gh pr list --author ruths-machine --draft --state open --json number,title,baseRefName,body
```

A draft is **ready to flip** when both hold:

- Its `baseRefName` is `main`. GitHub retargets the PR when its base branch merges and is deleted.
- Every blocker named in its issue's `## Dependencies` and in its epic row is closed.

Proposed action: `gh pr ready <N>` and `gh pr edit <N> --add-assignee ruthmarks151`. A draft whose base is `main` but has an open blocker stays draft. Name the blocker in the report.

---

## Step 3 — Backlog picks from the epics

```bash
gh issue list --state open --search "Epic in:title" --json number,title
gh issue view <epic> --json body -q .body
gh pr list --state open --json number,title,isDraft,headRefName   # to spot tickets that already have a PR
```

Read each epic's priority and its children's in one query:

```bash
gh api graphql -F n=<epic> -f query='query($n:Int!){repository(owner:"wildflowerhealthio",name:"Wildflower"){issue(number:$n){
  issueFieldValues(first:10){nodes{... on IssueFieldSingleSelectValue{name field{... on IssueFieldSingleSelect{name}}}}}
  subIssues(first:50){nodes{number state issueFieldValues(first:10){nodes{... on IssueFieldSingleSelectValue{name field{... on IssueFieldSingleSelect{name}}}}}}}}}}'
```

For each epic, classify every open, non-struck child:

- **Taken** — it has an open PR (its `#N` is in a PR title), or someone other than `ruths-machine` is assigned. Skip it.
- **Not ready** — labelled `🎟️ intake` or `🎟️ drifted`, or its body still has open **to confirm** items. List it only if it would otherwise be a top pick, flagged "needs grooming (`/backlog-grooming`)".
- **Ready** — every depends-on issue is closed. It can start on `main` today.
- **Stackable** — every depends-on issue is closed **or** has an open PR. It can start stacked on that PR's branch. It ranks below Ready, because a stacked PR stays draft until its base merges.
- **Blocked** — anything else. Don't list it.

Also consider open `🎟️ Accepted` issues outside every epic, such as standalone bugs. Their only dependencies are what their `## Dependencies` section names.

**Rank the Ready and Stackable items** by:

1. **Priority.** STAT, then ASAP, then Urgent, then Routine. A STAT or ASAP item leads the report even if it's hard; say so in its reason.
2. **Unblocks the most.** Count the epic rows that list the item as a dependency. Integration points and wave-1 roots come first.
3. **Easy.** Look for these signals:
   - a short `## Scope` checklist
   - a few `## Key files`, all within one slice
   - a named precedent to mirror ("mirror X", "Builds on #M (done)")
   - a bug-shaped title (states wrong behaviour)
   - the `📠 needs machine` label
   - no to-confirm items

   These count against easy: new packages, Rust and TS both, migrations, or a user-facing flow that needs a manual E2E check.
4. **Epic momentum.** Prefer the epic whose PR stack is closest to landing.

Keep the list short: about 5 picks, each with a one-line reason.

---

## Step 4 — Report

```md
## Assigned to the machine
- #815 chore(deps): … — **Review** (no review since last push) → `/code-review high --comment 815`
- #805 synthetic-data-app … — **Answer review** (ruthmarks151 reviewed 2026-09-29, 4 unresolved threads)
- #798 shoppers-drugmart-source: … (issue) — **Implement**

## Stacks ready to flip
- #800 (base now `main`, #790's blockers closed) → mark ready, assign ruthmarks151

## Waiting on ruthmarks151
- 3 ready PRs assigned to her: #801, #804, #812   ← one line, context only

## Backlog picks
| Pick | Epic | Priority | State | Why |
|---|---|---|---|---|
| #571 1B: shared dev-port reader | #570 | Urgent | Ready | unblocks 3A; one file + tests, mirrors …|
| #794 Synthetic data 7 | #787 | Routine | Stackable on #804 | … |
```

Omit empty sections. `gh pr list --assignee ruthmarks151 --state open` fills the "Waiting on" line.

---

## Step 5 — Offer to run, then run the picks

Ask with `AskUserQuestion` (`multiSelect: true`). List the machine assignments first, then stack flips, then the top backlog picks. The tool allows at most 4 options, so group them if needed (e.g. "Flip all 2 ready stacks"). The user can name others through "Other".

Run what was picked:

- **Review** → `/code-review high --comment <N>`. Never add `--fix` here: the skill forks against the session's main checkout, which may be the user's own branch.
- **Answer review** → follow `.claude/commands/answer.md`, with the in-scope rule from Step 1. Work in a `.devcontainer/wf-worktree.sh` worktree of the PR branch.
- **After an assigned PR is done** → `gh pr edit <N> --remove-assignee ruths-machine --add-assignee ruthmarks151`.
- **Flip** → `gh pr ready <N>` and `gh pr edit <N> --add-assignee ruthmarks151`.
- **Implement** → the normal flow. Work in a worktree and follow the Review Standards. Open the PR **ready and assigned to `ruthmarks151`** if its base is `main` with no open blockers. Otherwise open it as a **draft** and name the base PR in the body.

---

## Anti-patterns

- 🚫 Acting before the user picks. Steps 1–4 are read-only.
- 🚫 Reviewing a PR that has a fresh `ruthmarks151` review. Answer it instead.
- 🚫 Marking a PR ready while its base is another PR, or while a blocker is open.
- 🚫 Leaving `ruths-machine` assigned after finishing, or leaving a ready PR unassigned.
- 🚫 Suggesting a ticket that already has an open PR, or one still in `🎟️ intake`.
- 🚫 Guessing the board's Status. It's unreadable from here, so work from the epics and say so.
- 🚫 Including any model identifier in comments, reviews or PR bodies.
