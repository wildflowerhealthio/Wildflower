# answer

Address PR review comments marked with a rocket emoji reaction. Works locally, then acknowledges each addressed comment on GitHub.

**PR URL:** $ARGUMENTS

## Steps

1. **Parse the PR URL** to extract owner, repo, and pull number from the GitHub URL (e.g., `https://github.com/owner/repo/pull/123`).

2. **Safety check — verify local history includes the PR.** Get the PR's head commit SHA using `gh pr view`. Run `git cat-file -t <sha>` to confirm it exists locally. If it doesn't, **stop and tell the user** — they likely need to fetch or switch branches. Do not proceed.

3. **Gather all comments.** Fetch both types:
   - **Review comments** (inline on code): `gh api repos/{owner}/{repo}/pulls/{pull_number}/comments --paginate`
   - **Issue comments** (top-level): `gh api repos/{owner}/{repo}/issues/{pull_number}/comments --paginate`

4. **Filter for rocket-reacted comments.** Each comment's response includes a `reactions` summary with counts (e.g., `"rocket": 1`). Filter to comments where `reactions.rocket > 0`. No need to fetch the detailed reactions endpoint unless you need to know _who_ reacted.

5. **Group and address rocket comments.** Group related comments into logical batches — by file, by concern, or by dependency. Launch one subagent (Agent tool) per group, not per comment. Each subagent receives:
   - All comment bodies in the group
   - The file paths and line references
   - Instructions to make the fixes locally and return a summary

   This encourages the subagent to build context across related comments and avoids file edit collisions. Only run groups in parallel if they touch completely separate files.

6. **Acknowledge each addressed comment on GitHub.** For each comment that was successfully addressed:
   - Resolve the root comment.
   - Only add a follow-up reply comment if something non-obvious happened that the reviewer should know about (e.g., "Addressed this differently because X" or "This also required changing Y"). Don't reply just to say "done."

7. **Summarize** what was addressed, listing each comment and what was changed.

## Guidelines

- **Local work only.** All fixes happen in the local working directory. Never push — the user's SSH key requires a password. Ask them to push when done.
- **Rocket = do it.** The rocket emoji is the signal that a comment should be acted on. Ignore comments without rocket reactions.
- **Don't over-interpret.** If a comment is ambiguous about what change is needed, ask the user rather than guessing. Use `AskUserQuestion` with the comment text quoted.
- **Respect the PR scope.** Only make changes relevant to the flagged comments. Don't refactor surrounding code or fix unrelated issues.
- **If no rocket comments found**, tell the user and stop.
