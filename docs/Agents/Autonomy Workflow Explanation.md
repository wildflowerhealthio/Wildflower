# Autonomy Workflow Explanation

**Status:** Proposal / design spec. Nothing here is wired up yet. This doc is the blueprint we align on before authoring the new skills, trigger configs, and policy edits it describes. Where it proposes concrete artifacts (labels, skill files, trigger YAML), those are *specifications to build*, not descriptions of what exists.

This explains how Wildflower's agent workflow becomes **ticket-centric** and gains **graduated autonomy** — so an agent can carry a task from a ready ticket to a self-reviewed PR with the human entering only at the points where judgment actually matters.

## Why this exists

Today the workflow is effective but human-paced at every seam. The human:

1. Devises a task (sometimes recorded as a GitHub issue).
2. Briefs an agent, which researches and asks clarifying questions.
3. The agent implements in a worktree and, when done, the human pushes.
4. The human assigns a *separate* agent to `/review-pr`.
5. The human reviews, reacts with action-item emojis (🎉/😄/😕/🚀) to greenlight items, and adds their own rocket-tagged comments.
6. The human tells the original agent to `/answer` the tagged items.
7. Manual testing and tweaking, then merge.

Every numbered step is a human-initiated handoff. The agents are capable of more continuous motion than the workflow allows; the constraints are environmental (local SSH push needs a password, so agents *can't* push) and policy (AGENTS.md tells every agent to clarify-before-starting and never branch/commit/push on its own). Those constraints made sense for a human-present, local agent. They are now the bottleneck, because tasks increasingly run in **dev containers and web sessions** where the agent has a fresh clone, token-based push, and no human sitting beside it.

The goal is not "remove the human." It is to **move the human's attention to the few high-leverage decision points** — shaping a ticket, reviewing a PR — and let the agent own the mechanical connective tissue in between.

## The two ideas everything else hangs on

### 1. Execution modes

An agent session runs in one of two modes. The mode determines how it handles ambiguity, whether it may push, and how it communicates.

| | **Interactive** | **Autonomous** |
|---|---|---|
| **Human present?** | Yes — reachable in real time | No — human is async at best |
| **Where** | Local checkout, paired session | Dev container, scheduled/triggered web session |
| **Clarifies by** | `AskUserQuestion`, blocking | Ticket comments; bounce or block (see [Ambiguity protocol](#ambiguity-and-escalation)) |
| **Git push** | Never (SSH needs a password) — human pushes | Expected — branch, commit, push, open PR |
| **Scope changes** | Ask first (branch/commit/stash/online search) | Branch/commit/push are the job; still surfaces design forks |
| **Ends a task by** | Handing back to the human in-session | Leaving a PR + status comment on the ticket |

Mode is **not** auto-detected by cleverness. A session knows its mode from its launch context: a human typing in a terminal is Interactive; a trigger-spawned or dev-container session told "you are running autonomously" is Autonomous. The new skills take a mode signal (or infer it from "is there a Handoff/assignment driving me with no human in the loop"). When in doubt, an agent treats itself as Interactive — the safer default.

This is the policy change the dev-container shift forces: the blanket "clarify first, never push, ask before committing" rules in AGENTS.md were written for Interactive sessions only. They now live under an explicit mode banner. See [Policy changes](#policy-changes-needed).

### 2. The ticket *is* the unit of work

Every task starts as a GitHub issue and stays the durable record of it — superseding the `Handoff.md` file as the cross-session carrier (Handoff.md remains useful for *intra-machine, mid-task* continuity; the ticket is the *durable, cross-session* one). Two axes describe a ticket:

**Lifecycle labels** (where it is in the pipeline — human-ordered):

| Label | Meaning |
|---|---|
| `intake` | Captured but not ready to schedule or work. Where Claude-authored tickets and raw ideas land. |
| `backlog` | Vetted, will be done eventually. |
| `ready` | A shaped *field* of tickets — each could be started with no further planning. The working pool. |
| `on deck` | The single most-next thing pulled from `ready`: "if you're free, do this one for sure." The highest-priority pick. |

Priority runs `intake → backlog → ready → on deck`, with `on deck` at the front: `ready` is the deep field of workable tickets, `on deck` is the one to grab next.

**Routing labels** (who should work it):

| Label | Meaning |
|---|---|
| `needs-human` | Requires a person (taste, external coordination, or an autonomous attempt bounced). |
| `needs-machine` | Suitable for an autonomous agent. |

**The go-signal is assignment, not a label.** Labels are the human's prioritized ordering and routing hints. The moment a ticket is **assigned to the machine user** (Ruth's machine account — exact handle TBD, referred to here as `@machine-user`), it is fair game for an Autonomous session to pick up. The human only assigns things already vetted as ready, so assignment carries the "go" that a label can't (labels drift; an explicit assignment is a deliberate act). `ready` + `needs-machine` is the *expected shape* of an assigned ticket, but assignment is what an autonomous pickup queries on.

## The pipeline, end to end

```
                 ┌──────────────────────────────────────────────────────┐
                 │                     scout (autonomous)               │
                 │     "go find improvements" → opens tickets in intake │
                 └───────────────────────────┬──────────────────────────┘
                                             │
   idea ──▶ intake ──▶  plan-ticket  ──▶  ready ──▶ on deck  ──▶  assign @machine-user
            (issue)   (interactive,       (field)   (the one      │  ← THE GO-SIGNAL
                       back-and-forth               to grab next) │
                       on the issue)                              ▼
                                                       pickup-ticket (autonomous)
                                                              │
                                                              ▼
                                          implement ─▶ push ─▶ open PR ─▶ /review-pr (self-review)
                                                              │
                                                              ▼
                                                      ◀ STOP: wait for human review ▶
                                                              │
                       human reviews, reacts 🚀 on items, adds rocket comments
                                                              │
                                                              ▼
                                              /answer  (human-kicked)  ─▶  merge

  ┌─ refresh-tickets (autonomous, scheduled sweep) ────────────────────────────────┐
  │  periodically re-checks on-deck/ready tickets against current main, comments    │
  │  when an approach has gone stale, relabels if needed                            │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

### Stage notes

- **Shaping (`plan-ticket`, Interactive).** The human and an agent iterate on the issue itself — research, proposed approach, open questions — using ordinary issue comments. Readiness is expressed by the human moving the ticket to `ready`/`on deck` and assigning `@machine-user`. The "let's talk synchronously" escape hatch: when async comment cadence is too slow, the agent's comment says so and the human opens a live (Interactive) session to pair, then the ticket goes back to async.
- **Pickup (`pickup-ticket`, Autonomous).** Queries issues assigned to `@machine-user`, picks one, reads the shaped ticket as its brief (the ticket plays the role `Handoff.md` plays locally), does a **lazy refresh check** against current main before implementing, then works.
- **Implement → self-review.** The autonomy ceiling for a web session: implement → push → open PR → run `/review-pr` on its own PR → **stop**. It does *not* self-`/answer`. The human's review is the next gate. (Self-review by the same lineage that wrote the code is weaker than an independent reviewer, but it catches the obvious class of issues before the human spends attention — and `/review-pr` already fans out to fresh subagents, which mitigates author-blindness somewhat.)
- **Review + answer (human-kicked).** Unchanged from today's loop, and deliberately so: the human reacts 🚀 to greenlight, and `/answer` runs on demand. Automating `/answer` off `subscribe_pr_activity` webhooks is a *future* extension, not part of this design — the human review gate stays human.
- **Refresh (`refresh-tickets`, Autonomous scheduled sweep).** Main moves under shaped-but-unstarted tickets. A scheduled session re-reads `on deck`/`ready` tickets, checks whether their planned approach still holds, and comments / relabels when it doesn't — so a ticket the human assigns is still accurate.
- **Scout (`scout`, Autonomous).** Either as a dedicated "go find improvements" run or as a side effect of other work, the agent opens tickets into `intake`. They are **never** auto-assigned to `@machine-user`; the human promotes them out of `intake`. Claude proposes, the human disposes.

## Skills catalog

Existing skills keep their jobs; the new ones fill the autonomy gaps. Every skill is **hybrid** — the same skill file is invocable by a human (`/skill`) and by a trigger-spawned session. The difference is mode, which changes push behavior and ambiguity handling, not the skill's core steps.

### Existing (unchanged in spirit, mode-aware on push)

| Skill | Role | Mode change |
|---|---|---|
| `review-pr` | Fan-out PR review, posts one emoji-tagged review | None — already read-only. Now also invoked by the autonomous self-review step. |
| `answer` | Address 🚀-reacted review items locally | Push clause becomes mode-aware (autonomous may push; interactive still asks). |
| `handoff` / `pickup` | `Handoff.md`-based intra-machine continuity | Stay file-based for in-session handoff; tickets supersede them for durable cross-session work. Push clause mode-aware. |
| `done` / `quality-check` | Wrap-up + pre-push self-review | Push clause mode-aware. |
| `rev` | Convention revision | None. |

### Proposed new skills

Each is specified here at the level we need to agree on; the actual skill files come after sign-off.

**`plan-ticket`** *(primarily Interactive)*
Shapes an `intake`/`backlog` ticket toward `ready`. Researches the codebase, drafts an approach as an issue comment, and runs the clarify loop **on the issue** (comments + `AskUserQuestion` when a human is present). Output: an issue whose body/last comment is a crisp, current brief. Does not implement. Surfaces the "let's pair synchronously" flag when async is too slow.

**`pickup-ticket`** *(primarily Autonomous)*
The ticket-sourced analog of `/pickup`. Queries `@machine-user`-assigned issues, selects one (or takes an issue number as an argument), reads it as the brief, runs a lazy refresh check vs current main, then implements → push → open PR → `/review-pr` → stop. On ambiguity, follows the [escalation protocol](#ambiguity-and-escalation). Leaves a status comment + draft PR no matter how it exits, so the work can always be restarted.

**`refresh-tickets`** *(Autonomous, scheduled)*
Sweeps `on deck`/`ready` tickets, diffs each ticket's assumed approach against current main, and comments / relabels stale ones. Read-and-comment only; never implements. Keeps assigned tickets trustworthy.

**`scout`** *(Autonomous)*
"Go find improvements." Surveys the codebase (or a named area), opens well-formed tickets into `intake` with a consistent template, dedupes against existing open issues. Never self-assigns.

> A dedicated `close-loop` skill is intentionally *not* proposed — the implement→push→PR→self-review sequence is composed inside `pickup-ticket` rather than split out, because every step shares the same ticket context and splitting it would re-introduce a handoff seam.

## Triggers and substrate (the hybrid model)

Skills are the unit of work; triggers are just one way to invoke them. The same `pickup-ticket` a human runs with `/pickup-ticket #123` is what a trigger runs.

Three trigger surfaces, all via Claude Code on the web (see the [Claude Code on the web docs](https://code.claude.com/docs/en/claude-code-on-the-web) — exact trigger/workflow config should be verified against the live docs before implementing; the shapes below are the *intent*, not validated YAML):

| Trigger | Fires | Runs | Mode |
|---|---|---|---|
| **Assignment event** | Issue assigned to `@machine-user` | `pickup-ticket` for that issue | Autonomous |
| **Schedule** | Cron (e.g. nightly) | `refresh-tickets`; optionally `scout` | Autonomous |
| **Manual** | Human types the slash command | Any skill | Interactive |

Network policy and environment config for these sessions follow the environment's chosen policy; the autonomous sessions need push access (token-based, available in web/dev-container — unlike local SSH) and GitHub MCP scope for `assessment-is/wildflower`.

## Ambiguity and escalation

When an Autonomous session hits a real fork it can't resolve, the order of preference is:

1. **Bounce to `needs-human`** *(preferred).* Relabel the ticket `needs-human`, leave a comment stating the fork and the options, and stop. The work is deferred to a person rather than guessed.
2. **Block and wait on the ticket** *(when bouncing loses too much context).* Post the specific question(s) as a ticket comment and stop, leaving a **draft PR** capturing work-in-progress so a later session can resume without redoing it. (The human is generally reachable, so this often turns around quickly.)
3. **Proceed on documented defaults** *(only for low-stakes, reversible calls).* Make the reasonable assumption, record it as a comment ("Assumed X because Y"), and let the human catch it at PR review.

**Always leave a trail.** However a session exits — done, bounced, or blocked — it leaves a status comment on the issue describing the current state and a draft PR if any code exists. The invariant: *no autonomous session ever ends with un-restartable work.* This is what makes the autonomy safe to trust — a bad run costs a review, never lost work.

The interactive clarify rule ("ask, ending with 'do you think I understand well enough to start?'") is unchanged for Interactive mode. Autonomous mode replaces it with this protocol, because there's no one to ask in real time.

## Policy changes needed

These are the edits to existing config this design requires. (Applied on this branch alongside this doc — review them as part of the proposal.)

1. **AGENTS.md — add an `Execution Modes` section** defining Interactive vs Autonomous and linking here.
2. **AGENTS.md — `Clarify before building or planning`** scoped to Interactive; Autonomous defers to the [escalation protocol](#ambiguity-and-escalation).
3. **AGENTS.md — `Ask for guidance before expanding scope`** clarified: in Autonomous mode, branching/committing/pushing is the job, not scope expansion. Online search and writing throwaway verification code still warrant a surfaced note.
4. **Skills `handoff` / `pickup` / `done` / `answer`** — the literal "Never git push. The user's SSH key requires a password" line becomes mode-aware: it states the Interactive rule and points to the mode policy for Autonomous sessions, which push.

## Risks and open questions

- **Self-review is not independent review.** The autonomous session reviewing its own PR shares the author's blind spots. Mitigation: `/review-pr` uses fresh subagents, and the human gate stays. If self-review proves low-value, drop it and go straight to the human.
- **`@machine-user` exact identity** — needs the real GitHub handle and a token/scope with push + PR rights on `assessment-is/wildflower`.
- **Trigger config fidelity** — the trigger shapes above must be reconciled with the live Claude Code on the web trigger model before building.
- **Scout noise** — an over-eager `scout` floods `intake`. Needs a dedupe + a quality bar, and possibly a cap per run.
- **Mode mis-detection** — a session that wrongly thinks it's Autonomous could push unexpectedly. The "default to Interactive when unsure" rule is the guard; worth a belt-and-suspenders check (e.g. only push when an explicit autonomous-mode env signal is present).

## Phased rollout (suggested)

1. **Policy + modes first** (this branch): land the AGENTS.md mode section and mode-aware push so dev-container agents can already push and self-PR.
2. **`pickup-ticket`**: the highest-leverage single skill — closes the assign→PR→self-review gap.
3. **`plan-ticket`**: tighten the shaping loop on the issue.
4. **`refresh-tickets` + schedule trigger**: keep assigned tickets current.
5. **`scout`**: last, once the intake→promote discipline is proven.

## See also

- [AGENTS Explanation](./Explanation.md) — what AGENTS.md is (config, not docs) and how mode rules belong in it
- [Agent Strategies](./Strategies.md) — context discipline these autonomous sessions must still respect
- [`answer`](../../.claude/commands/answer.md) / [`review-pr`](../../.claude/commands/review-pr.md) — the emoji-greenlight review protocol the loop builds on
- [`handoff`](../../.claude/commands/handoff.md) / [`pickup`](../../.claude/commands/pickup.md) — the file-based continuity tickets supersede for durable work
- [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) — trigger/session model the autonomous substrate uses
