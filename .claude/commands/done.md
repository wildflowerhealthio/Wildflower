# done

Task wrap-up checklist — run health checks, surface next steps, and execute before ending a session.

## Steps

1. **Review repo state** — Run `git status` and `git diff` (staged and unstaged) to see what's changed. Do NOT run typecheck, lint, or tests automatically.

2. **Build a context-aware next-steps checklist.** You're running at the end of a session — you have deep context about what was done, what was tricky, and what's still loose. Use that accumulated judgment here. Examine the actual diff, commit history, and repo state, but also draw on everything you learned during the session. Use `AskUserQuestion` with `multiSelect: true`. Only include items that are genuinely worth doing based on your understanding of the work — never pad with generic filler. Each item should reference specific files or changes. Possible items (include only when warranted):
   - Run typecheck, lint, or tests (only suggest if you have reason to think something may be broken)
   - Update docs that describe changed behavior (list specific file paths)
   - Add or update tests for new or changed code (list specific files lacking coverage)
   - Commit uncommitted changes (summarize what would be committed)
   - Open a pull request (suggest branch name and base branch)
   - Run `npm run format` and/or `npm run lint:fix`
   - Clean up temporary or debug code (list specific locations)
   - Update AGENTS.md or a reference doc if new patterns were established

   The **last option must always be**:
   - "Update Learnings Inbox"

3. **Execute** the items the user selected, in logical order:
   - Formatting/linting before commits
   - Commits before PRs
   - Doc updates and learnings inbox entries last

4. **Learnings Inbox entries** use this format and are appended below the `<!-- Append new entries below this line -->` marker in `docs/Agents/Learnings Inbox.md`. Never edit or delete existing entries.

   ```markdown
   ### [short title]

   **Discovered during**: [task or branch name]
   **Learning**: [the actionable insight]
   **Suggested destination**: Strategies | [path to a specific reference doc] | unsure
   ```

## Guidelines

- **Be specific, not generic.** Every checklist item should reference concrete files, functions, or changes from the session.
- **Pushing is mode-dependent.** In Interactive mode, never push — the user's local SSH key requires a password; if a push or PR is selected, stop and ask the user to run the git command manually. In Autonomous mode (dev container / triggered session), push as normal. See [Execution Modes](../../AGENTS.md#execution-modes).
- **Nothing to do is fine.** If the working tree is clean, tests pass, and there are no TODOs, say so and end.
- **Keep output concise.** Summarize health check results rather than dumping raw command output.
- **Trust your session context.** You've been working in this codebase all session. Use your judgment about what matters — you know what was hard, what's fragile, and what the user cares about. The examples in step 3 are just a menu of possibilities, not a template to fill in.
