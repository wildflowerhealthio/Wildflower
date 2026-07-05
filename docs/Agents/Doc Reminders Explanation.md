# Doc Reminders Explanation

Why agents get "docs relevant to this path" nudges injected mid-session, and how the mechanism is put together.

## The problem

Agents burn context re-deriving conventions from code that a doc already states, and they conform better when the doc is in context _before_ they write. CLAUDE.md links the docs, but a link at session start competes with everything else; the useful moment to surface a doc is when the agent first touches the area it covers.

## The mechanism

A `PostToolUse` hook (registered in [.claude/settings.json](../../.claude/settings.json)) runs [doc-reminders.mjs](../../.claude/hooks/doc-reminders.mjs) after every `Read`, `Grep`, `Glob`, `Edit`, and `Write` call. The script:

1. Extracts the file path from the tool input and makes it repo-relative.
2. Tests it against the rules in [doc-map.json](../../.claude/hooks/doc-map.json) — each rule is a regex, a tool scope (`edit` fires only on Edit/Write; `any` also fires on reads), and a list of doc pointers.
3. Injects the matching pointers into the agent's context via the hook's `additionalContext` output — **at most once per session per rule**, tracked in a session-keyed state file under the OS temp dir.
4. Fails open: malformed input, a missing map, or any other error produces no output rather than a broken tool call.

`doc-map.json` is the single source of truth for the mapping. There is deliberately no duplicated human-readable table of it here — the JSON carries a `$comment` and per-rule doc lines that read fine directly, and two copies would drift.

## Division of labor with AGENTS.md

Directory-scoped traps belong in that directory's AGENTS.md (Claude Code auto-loads the `CLAUDE.md` symlink when working there). The doc-map covers what path proximity alone won't surface: cross-cutting docs (testing, documentation conventions, Effect patterns, the bridge) whose relevance is signaled by file _kind_ or _name pattern_ rather than by directory.

When adding a doc that agents should be nudged toward, add a rule (or extend an existing rule's `docs`) in `doc-map.json`. Keep rules coarse and messages short — the reminder's job is a pointer, not a summary.

## See also

- [AGENTS Explanation](./Explanation.md) — what AGENTS.md files are for
- [Documentation Explanation](../Documentation/Explanation.md) — the four-kinds system the pointed-to docs follow
