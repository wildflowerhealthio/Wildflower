# answer

Address PR review comments that have been reacted to with one of the four action-item emojis. Works locally, then acknowledges each addressed comment on GitHub.

**PR URL:** $ARGUMENTS

## Action-item emojis

Reviewers tag each suggested action with one of these GitHub reaction emojis. The set is shared with `/review`:

- 🎉 `:tada:` — hooray/tada
- 😄 `:smile:` — laugh/smile
- 😕 `:confused:` — confused
- 🚀 `:rocket:` — rocket

Comments authored by `/review` follow this structure: an **analysis** paragraph at the top (no emoji prefix), followed by one or more lines each prefixed with one of the four emojis. Each emoji-prefixed line is a distinct action item. A comment that's plain prose with no tags (typically authored by hand) is offering a single implicit action item.

## Steps

1. **Parse the PR URL** to extract owner, repo, and pull number from the GitHub URL (e.g., `https://github.com/owner/repo/pull/123`).

2. **Safety check — verify local history includes the PR.** Get the PR's head commit SHA using `gh pr view`. Run `git cat-file -t <sha>` to confirm it exists locally. If it doesn't, **stop and tell the user** — they likely need to fetch or switch branches. Do not proceed.

3. **Gather all comments.** Fetch both types:
   - **Review threads** (inline on code, grouped with resolution status): use the GraphQL `reviewThreads` connection so you get `isResolved` per thread alongside each comment's `reactionGroups`. Example:
     ```
     gh api graphql -f query='query($owner:String!,$repo:String!,$number:Int!){
       repository(owner:$owner,name:$repo){pullRequest(number:$number){
         reviewThreads(first:100){nodes{
           id isResolved isOutdated
           comments(first:50){nodes{
             id databaseId author{login} path body url
             reactionGroups{content reactors{totalCount}}
           }}
         }}
       }}
     }' -f owner=OWNER -f repo=REPO -F number=NUMBER
     ```
   - **Issue comments** (top-level): `gh api repos/{owner}/{repo}/issues/{pull_number}/comments --paginate`

4. **Filter for in-scope comments.** Apply both filters — resolution first, then reactions:
   - **Skip any comment whose review thread has `isResolved: true`.** Resolved threads are done — the reviewer has accepted them as closed, even if old action-item reactions are still present. Never re-address a resolved thread. (Issue comments don't have thread resolution; the reaction filter alone applies.)
   - Of the remaining (unresolved) comments, a comment is in scope when:
     - It is plain prose (no emoji tags in body) **and** has a 🚀 reaction (`ROCKET` reactor count > 0) — the rocket is the trigger for single-action comments, OR
     - Its body contains one or more emoji-tagged action items (🎉/😄/😕/🚀 prefixing a line) **and** any of `HOORAY`, `LAUGH`, `CONFUSED`, or `ROCKET` has a reactor count > 0.

   No need to fetch the detailed reactions endpoint unless you need to know _who_ reacted.

5. **Determine the action items per comment.**
   - Plain prose comment: one implicit action item — do what the comment asks if an only if the comment is tagged with `reactions.rocket`.
   - Tagged comment: read the analysis paragraph (if present) for context, then address the action items from the body which have a corresponding reaction tag. If two reactions are present for items that seem to conflict (e.g., one says "delete this", another says "rename it"), stop and ask the user via `AskUserQuestion` rather than guessing.


6. **Group and address comments.** Group related comments into logical batches — by file, by concern, or by dependency. Launch one subagent (Agent tool) per group, not per comment. Each subagent receives:
   - The comment bodies in the group, with each tagged action item enumerated
   - The file paths and line references
   - Instructions to make the fixes locally and return a summary

   This encourages the subagent to build context across related comments and avoids file edit collisions. Only run groups in parallel if they touch completely separate files.

7. **Acknowledge each addressed comment on GitHub.** For each comment that was successfully addressed:
   - Resolve the root comment.
   - Only add a follow-up reply comment if something non-obvious happened that the reviewer should know about (e.g., "Addressed this differently because X" or "This also required changing Y"). Don't reply just to say "done."

8. **Summarize** what was addressed, listing each comment and what was changed.

## Guidelines

- **Local work only.** All fixes happen in the local working directory. Never push — the user's SSH key requires a password. Ask them to push when done.
- **Resolved threads are out of scope.** Always check `isResolved` first — a resolved thread is closed work, regardless of the reactions on it.
- **Reactions are the go signal.** 🚀 on a plain comment, or any of 🎉/😄/😕/🚀 on a multi-tag comment, means "address this." Comments without these reactions are ignored.
- **Don't over-interpret.** If a comment is ambiguous about what change is needed, ask the user rather than guessing. Use `AskUserQuestion` with the comment text quoted.
- **Respect the PR scope.** Only make changes relevant to the flagged comments. Don't refactor surrounding code or fix unrelated issues.
- **If no in-scope comments are found**, tell the user and stop.
