# handoff

Hand off the current task to a future agent session. Finishes immediate work, writes a Handoff.md, and updates the Learnings Inbox.

## Steps

1. **Finish the immediate subtask** — if there's something small in flight that's quicker to finish than explain, finish it now. Don't start anything new. The goal is to get to writing as fast as possible.

2. **Run `git status`** — just enough to note branch name, dirty files, and staging state for the handoff doc. No typecheck, no lint, no tests.

3. **Write `Handoff.md` at project root.** Overwrite any existing one — a new handoff always supersedes the previous. Write primarily from your accumulated session knowledge. Do not re-read files, launch explore agents, or run commands to gather information you already have. Use this structure:

   ```markdown
   # Handoff

   ## What we're doing and why

   [High-level goal, motivation, key decisions made]

   ## What's done

   [File list with status, or description of completed work]

   ## What remains

   [Remaining tasks with notes on anything non-obvious]

   ## Key files to read first

   [3-5 files the next agent should read to get oriented]

   ## Gotchas and context the next agent needs

   [Failure modes, patterns that break, decisions that weren't obvious, things tried and abandoned]

   ## Current state

   [Branch name, dirty files, anything staged, relevant git state]
   ```

4. **Update Learnings Inbox** — after Handoff.md is written, append any non-obvious learnings discovered during this session to `docs/Agents/Learnings Inbox.md`. Use the standard entry format:

   ```markdown
   ### [short title]

   **Discovered during**: [task or branch name]
   **Learning**: [the actionable insight]
   **Suggested destination**: Strategies | [path to a specific reference doc] | unsure
   ```

   Append below the `<!-- Append new entries below this line -->` marker. Never edit or delete existing entries. If there are no learnings worth recording, skip this step.

## Guidelines

- **Context is scarce.** You're running this late in a session. Write from memory — you know what's in the files, what was hard, and what matters. Don't burn remaining context on exploration or verification.
- **The Handoff.md is the deliverable.** Optimize for the next agent's cold start. What would you want to read if you were picking this up fresh?
- **Document failure modes, not just the happy path.** The gotchas section is the most valuable part — include patterns that break, edge cases discovered, and approaches that were tried and abandoned.
- **Overwrite, don't append.** If Handoff.md already exists, replace it entirely.
- **Pushing is mode-dependent.** In Interactive mode, never push — the user's local SSH key requires a password; ask them to run push manually if needed. In Autonomous mode (dev container / triggered session), push as normal. See [Execution Modes](../../AGENTS.md#execution-modes).
