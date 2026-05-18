# review

Review a PR by spawning topic-focused subagents in parallel, then submit their findings as a single GitHub review with inline comments.

**PR URL:** $ARGUMENTS

## Action-item emojis

Every action item in every comment must be tagged with one of these GitHub reaction emojis. The set is shared with `/answer`:

- 🎉 `:tada:` — hooray/tada
- 😄 `:smile:` — laugh/smile
- 😕 `:confused:` — confused
- 🚀 `:rocket:` — rocket

Tags exist so the PR author can react with the matching emoji to signal "do this," and so `/answer` can find the action items. The four emojis are equivalent labels — pick whichever feels right. The PR author reacts with a matching emoji to greenlight that specific action item.

### Comment structure

**Analysis first, then emoji-tagged actions.** A comment body looks like:

```
<one or two sentences explaining what's wrong and why it matters>

🎉 <action item 1>

🚀 <action item 2>
```

The analysis sits at the top, unprefixed. Each action item gets its own line, prefixed with exactly one emoji. **Repeat the emoji+action pair for every distinct action** — including separate concerns that share an analysis, separate alternatives, and primary-plus-follow-up pairs. If a comment has only one action item, the body is just analysis followed by one tagged line.

When a finding has two genuinely distinct sub-issues that share one analysis (e.g. "the log tag is wrong" plus "the term `serverLayer` is outdated"), split them into separate tagged lines rather than burying the second concern inside the first.

### Examples

Single-action comment:

```
The cast on line 42 bypasses the project's type-safety rule and the input isn't validated at this boundary.

🚀 replace the `as any` with a `Predicate.isString` guard
```

Multi-action comment (two distinct, both necessary):

```
The log tag identifies this as the expo package, but the file lives in `-core`, and `serverLayer` is outdated since the daemon now takes a `startServer` Effect rather than a Layer.

🚀 rename the tag to `[local-http-server-core]`

😕 replace `serverLayer failed` with `startServer failed`
```

Multi-action comment with genuine alternatives the author should pick between:

```
This `as unknown as Service` cast isn't on `CLAUDE.md`'s allowed-exceptions list, but the helper centralises N per-slice copies so removing it would regress.

🎉 add a paragraph to the JSDoc justifying the cast under the "deeply technical foundation" carve-out

🚀 extend `CLAUDE.md`'s exception list to mention `defineSliceLivestore`
```

Even if the only "alternatives" you'd offer for a one-line fix are paraphrases of each other (e.g. "raise numRuns to 50 OR document why it's 8"), use **two** action items phrased as the outcome ("numRuns: 8 reflects a real wall-clock budget"). Multi-emoji is a contract with the author — every line is a separate "go" target — so don't pad it.

### Concrete and terse

Each action item should name a specific change, it may depend on the analysis above to be understood. The emoji tag is the contract with `/answer`; the line after it is what gets done.

## Steps

1. **Parse the PR URL** to extract owner, repo, and pull number.

2. **Fetch PR metadata and diff.**
   - `gh pr view {pull_number} --repo {owner}/{repo} --json title,body,headRefOid,baseRefName,files`
   - `gh pr diff {pull_number} --repo {owner}/{repo}` for the full patch
   - Use the head SHA when posting the review (the API requires `commit_id`).

3. **Decide topic focuses.** Look at the diff: the files touched, their layers (domain/infrastructure/apps), the kinds of changes (new feature, refactor, bug fix), and the test coverage. Pick a handful of focus areas that actually have surface area in this PR. Examples — not a fixed list:
   - Type safety and the project's `any` / `@ts-ignore` rules
   - Effect idioms (generators vs pipelines, tagged errors, Layer composition)
   - Test quality (property-first, MECE, coverage of new exports)
   - Dependency rule compliance and slice layering
   - Doc comments on new/changed exports
   - Naming and API ergonomics
   - Security and input validation (if the diff touches boundaries)
   - Performance hot spots (if relevant)

   Skip topics with no signal in the diff. Don't spawn a security agent on a docs-only PR.

4. **Spawn one subagent per focus, in parallel.** Use `subagent_type: "general-purpose"`. In a single message, issue all the Agent tool calls so they run concurrently. Each subagent's prompt MUST include:
   - The focus area and what to look for
   - The PR URL, head SHA, and base branch
   - The list of changed files relevant to that focus
   - Pointers to relevant docs in `docs/` (e.g., `docs/Effect/Patterns Reference.md` for the Effect focus)
   - **The action-item emoji rules from this file** — each subagent must produce comments that follow the same tag conventions
   - The structured return format below
   - Instruction to be read-only — no file edits, no git operations

   Each subagent returns a JSON-shaped list of findings. Each `body` follows the **analysis first, then emoji-tagged actions** structure described in the "Action-item emojis" section above:

   ```
   [
     {
       "path": "slices/foo/foo-core/src/bar.ts",
       "line": 42,
       "side": "RIGHT",
       "body": "The cast bypasses the project's type-safety rule and the input isn't validated at this boundary.\n\n🚀 replace the `as any` with a `Predicate.isString` guard"
     },
     ...
   ]
   ```

   `line` refers to a line in the PR diff (use the new file's line number; `side: "LEFT"` only when commenting on a deleted line). For multi-line comments, include `start_line` and `start_side`.

5. **Combine findings into one review.**
   - Concatenate the subagents' finding lists.
   - Dedupe: if two subagents flagged the same line for overlapping reasons, merge into one comment with both concerns (still tag each action item with an emoji).
   - Sort by file, then line, for readability.
   - Edit any comment that violates the tag rules (missing emoji on an actionable line, multi-option without genuine alternatives, etc.) before submitting. Don't pass through subagent output uncritically — the orchestrator is the editor.

6. **Submit a single review.** Post all inline comments at once via the reviews API. There is no top-level summary body — inline comments only.

   ```bash
   gh api -X POST repos/{owner}/{repo}/pulls/{pull_number}/reviews \
     -f commit_id={head_sha} \
     -f event=COMMENT \
     -F 'comments=@comments.json'
   ```

   Where `comments.json` is the combined, deduped finding list. The review event is always `COMMENT` — this command does not approve or request changes.

   If the combined list is empty after dedup, do not submit an empty review. Tell the user nothing actionable was found.

7. **Report back.** Print the review URL (from the API response) and a one-line summary of how many comments were posted across how many files.

## Guidelines

- **One review, not many.** Never call the reviews API more than once per invocation, and never post comments via the per-comment endpoint (`POST /pulls/{n}/comments`) — that creates loose comments outside any review.
- **Tags are mandatory on action items.** A finding without an emoji tag is a finding the PR author can't react to and `/answer` will skip. Edit subagent output to add tags if missing.
- **Analysis first, then tagged actions.** Every body opens with the "what's wrong / why it matters" analysis, then one emoji-prefixed action item per line. Repeat the emoji+action pair for every distinct action — including separate concerns that share an analysis, and alternatives the author should pick between. See the "Action-item emojis" section for examples.
- **Read-only.** Neither the orchestrator nor the subagents modify files, run builds, or push anything. This command produces a GitHub review and nothing else.
- **Scope to the diff.** Comments must be on changed lines (or, for `side: "LEFT"`, deleted lines). Don't comment on untouched code, even if it's bad.
- **Subagents run in parallel.** All Agent tool calls go in a single message. Sequential spawning negates the point of using multiple focuses.
- **If the PR URL is missing or malformed**, ask the user via `AskUserQuestion` rather than guessing.