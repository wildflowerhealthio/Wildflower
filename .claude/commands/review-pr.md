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

The analysis sits at the top, unprefixed. Each action item gets its own line, prefixed with exactly one emoji.

**The core rule: one emoji per course of action.** Every distinct decision the author could greenlight independently is its own tagged line. The emoji is the reaction-target — if the author would want to say "yes do A but skip B," then A and B must be on separate lines with separate emojis. Never bundle two courses of action behind one emoji.

This applies whenever any of these are true:

- **Distinct concerns sharing one analysis** (e.g. "the log tag is wrong" *and* "the term `serverLayer` is outdated") — split.
- **Alternative approaches** the author should pick between — split.
- **Primary fix plus optional follow-up** (e.g. "rename the function" + "update the doc comment to match") — split.
- **The word "Or" (or "or", "alternatively", "either … or") appears in a single action item** — split. Any sentence of the form "do X or do Y" is two action items by definition; rewrite as one tagged line per option, each phrased as a concrete outcome.

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

Splitting an "Or" — wrong, then right:

```
# WRONG — bundles two courses of action behind one emoji
🚀 raise `numRuns` to 50, or document why 8 is the right ceiling
```

```
# RIGHT — one emoji per course of action, each phrased as the outcome
🎉 `numRuns` is 50, matching the rest of the suite

🚀 a comment on the `numRuns: 8` line explains the wall-clock budget that caps it there
```

Don't pad with paraphrases. Multi-emoji is a contract with the author — every line is a separate "go" target — so each tagged line must be a course of action the author can independently greenlight. If you find yourself writing two lines that lead to the same diff, you have one action item, not two.

### Concrete and terse

Each action item names a single specific change. It may depend on the analysis above to be understood, but on its own it describes exactly one diff the author can produce. The emoji tag is the contract with `/answer`; the line after it is what gets done. If a tagged line describes more than one outcome — separated by "or," "and also," or buried in a sub-clause — it isn't one action item, and it must be split.

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
   - Edit any comment that violates the tag rules before submitting — missing emoji on an actionable line, two courses of action behind one emoji, "or" / "alternatively" in a tagged line, or two tagged lines that resolve to the same diff. Don't pass through subagent output uncritically — the orchestrator is the editor.

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
- **Analysis first, then tagged actions.** Every body opens with the "what's wrong / why it matters" analysis, then one emoji-prefixed action item per line.
- **One emoji per course of action.** Every distinct decision the author could greenlight independently is its own tagged line. Split when any of these apply: separate concerns sharing one analysis, genuine alternatives, primary fix + optional follow-up, or any action item containing "or" / "alternatively" / "either … or". See the "Comment structure" section for examples.
- **Read-only.** Neither the orchestrator nor the subagents modify files, run builds, or push anything. This command produces a GitHub review and nothing else.
- **Scope to the diff.** Comments must be on changed lines (or, for `side: "LEFT"`, deleted lines). Don't comment on untouched code, even if it's bad.
- **Subagents run in parallel.** All Agent tool calls go in a single message. Sequential spawning negates the point of using multiple focuses.
- **If the PR URL is missing or malformed**, ask the user via `AskUserQuestion` rather than guessing.