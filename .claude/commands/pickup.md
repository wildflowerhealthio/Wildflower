# pickup

Pick up a task from a previous agent session using the Handoff.md document.

## Steps

1. **Read `Handoff.md`** at the project root. If it doesn't exist, tell the user there's no handoff to pick up and stop.

2. **Read the key files** listed in the "Key files to read first" section. Read only those files — don't explore broadly. The previous agent chose them deliberately.

3. **Summarize your understanding** — briefly tell the user what you understand the task to be, what's been done, and what remains.

4. **Ask clarifying questions** — use `AskUserQuestion` to confirm priorities, ask if anything has changed since the handoff, or resolve any ambiguities in the handoff doc. Don't barrel into the remaining work without checking in first.

5. **Delete `Handoff.md`** — it's been consumed. The presence of Handoff.md signals pending work; its absence signals the handoff has been picked up.

6. **Begin work** on the remaining tasks outlined in the handoff doc.

## Guidelines

- **Trust the handoff doc.** It was written by an agent with deep session context. Don't second-guess it or re-explore things it already covers.
- **Read the gotchas section carefully.** This is where the previous agent's hard-won knowledge lives. Ignoring it means repeating their mistakes.
- **If the handoff is stale or confusing, ask the user** rather than guessing. The user has context that spans across agent sessions.
- **Pushing is mode-dependent.** In Interactive mode, never push — the user's local SSH key requires a password; ask them to run push manually if needed. In Autonomous mode (dev container / triggered session), push as normal. See [Execution Modes](../../AGENTS.md#execution-modes).
