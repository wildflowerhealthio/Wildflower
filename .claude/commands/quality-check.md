# quality-check

Self-review uncommitted code before pushing. Own the quality — fix issues directly, report only what needs user judgment.

## Scope

Operates on **uncommitted changes** (staged + unstaged). Run `git diff` and `git diff --cached` to identify all changed and new files. These are the files under review.

## Phases

There are two phases. Phase 1 is a read-and-fix pass across several dimensions. Phase 2 runs mechanical checks and fixes anything they surface. If Phase 1 made changes, Phase 2 catches anything those changes broke.

---

### Phase 1 — Review and fix

Work through each dimension in order. For each one, scan all changed files, fix what you can, and surface what needs user input. Use `AskUserQuestion` to present grouped findings that require judgment — don't ask one-at-a-time.

Between dimensions, if you've made changes, do a quick sanity check that your fixes didn't break the file (re-read the area you edited). Don't run full typecheck/lint yet — that's Phase 2.

#### 1a. Diff hygiene

Scan the full diff for:

- **Debug code** — `console.log`, `console.debug`, `debugger`, `.only` on tests
- **Commented-out code** — blocks of code that are commented out rather than deleted
- **Unintended changes** — files that seem unrelated to the task (use your session context to judge)
- **Secrets or credentials** — API keys, tokens, passwords, `.env` values in the diff

**Action:** Remove debug code and commented-out code directly. For unintended changes or suspected secrets, ask the user via `AskUserQuestion`.

#### 1b. Type safety

Scan changed files for:

- `any` types (explicit or inferred)
- `@ts-ignore` or `@ts-expect-error` directives
- Unsafe casts (`as unknown as X`, `as any`)
- Non-null assertions (`!`) that mask potential issues
- **Type refinement** — when narrowing types, prefer type predicates (`Predicate.isString`, `Predicate.isNumber`, etc. from Effect's `Predicate` module) and guards from `@assessmentis/util` over manual type assertions. Type predicates compose well with `Array.filter`, `Option.flatMap`, `Effect.liftPredicate`, and pipeline-style code. Custom type guards should follow the `(value: Broad) => value is Narrow` pattern and live in the module that owns the narrowed type.

**Action:** Fix what you can by improving types. Replace inline narrowing with proper type predicates where possible. If a cast seems genuinely necessary, surface it to the user with an explanation of why, per CLAUDE.md rules.

#### 1c. Dependency rule compliance

Check that changed files respect the layered architecture:

| Layer          | May depend on                  | Must not depend on           |
| -------------- | ------------------------------ | ---------------------------- |
| domain         | global, other domain packages  | infrastructure, apps         |
| infrastructure | domain, global                 | apps, other infrastructure   |
| apps           | domain, infrastructure, global | other apps                   |
| global         | nothing project-specific       | domain, infrastructure, apps |

Also check: domain packages must be **pure** — no side effects, no HTTP, no DB, no file I/O.

**Action:** Flag violations via `AskUserQuestion`. These are usually design issues that need discussion, not quick fixes.

#### 1d. Doc comments (TSDoc)

Reference: `docs/Documentation/Doc Comments Reference.md`

Check all **new or changed exports** for:

- Every exported symbol has a doc comment
- Section ordering: summary → `@typeParam`/`@param`/`@returns` → `@remarks` → `@example`
- No JSDoc-isms (`@template` → `@typeParam`, `@module` → `@packageDocumentation`, `@description` → first paragraph, `@default` → `@defaultValue`)
- `@deprecated` includes migration code (before/after)
- Options objects extracted to named `{FunctionName}Options` interfaces
- React components mention non-prop state sources (hooks, context, event subscriptions) in the summary
- Params describe _meaning_, not type signatures the reader can already see

**Action:** Add or fix doc comments directly. Be opinionated — this is a review, not a suggestion.

#### 1e. Effect idioms

Reference: `docs/Effect/Patterns Reference.md`

Check changed Effect code for:

- **Generator vs pipeline** — generators for multi-step composition, pipelines for linear transforms. Would anything be clearer as the other?
- **Specific error classes** — tagged errors (`Data.TaggedError`) with meaningful fields, not generic strings or `Error`
- **Repository pattern** — domain defines the Tag interface, infrastructure provides the Layer
- **Schema with branded IDs** — not bare `string` for resource identifiers
- **`Effect.runSync`/`Effect.runPromise`** — should only appear at app boundaries, never in domain or infrastructure
- **Conciseness** — unnecessary intermediate variables, overly verbose generator steps that could be a single pipe

**Action:** Refactor directly. For judgment calls (e.g., generator vs pipeline where both are reasonable), ask the user.

#### 1f. Test quality

References: `docs/Testing/Testing Reference.md`, `docs/Testing/Property Testing Reference.md`, `docs/Testing/Unit Testing How-To.md`

Check that changed code has corresponding tests, and that those tests are good:

- **Coverage** — new exports and changed behavior have tests. Flag untested code.
- **Property-based first** — if a function takes structured input, it should have a property test using `Arbitrary.make(Schema)` or opaque arbitraries. Example-based tests are for regressions and documentation only.
- **MECE structure** — test branches are mutually exclusive and completely exhaustive, with `assert.fail` for impossible branches
- **Compact** — a single powerful property test beats ten trivial examples. If >5 cases test the same function, suggest a property test.
- **Colocated** — `*.test.ts` next to the source file
- **Effect testing patterns** — `Effect.runPromiseExit` for error path assertions, stubbed contexts for dependency injection
- **Round-trip properties** — schemas should have `decode(encode(x)) === x` tests

**Action:** Write missing tests or improve existing ones directly. For questions about _what_ to test (coverage scope), ask the user.

#### 1g. Suggested nearby cleanup

Now that you've read through the changed files in detail, suggest small improvements to **nearby code** (in the same files or closely related files) that would be worth making while you're here. These are things you noticed during the review but that aren't strictly part of the diff.

Examples:

- A function next to the one you changed has a misleading name or missing doc comment
- An adjacent test could be converted from example-based to property-based
- A nearby `pipe` chain would read better as a generator (or vice versa)
- Dead code or unused imports sitting next to the changes
- A type that could be tightened now that you see how it's actually used
- A pattern inconsistency between the changed code and its neighbors

**Action:** Present suggestions via `AskUserQuestion` with `multiSelect: true`. Group by file. Each suggestion should be concrete enough that the user can judge it without reading the code — include the file, the location, and what you'd change. Only execute the ones the user selects.

---

### Phase 2 — Mechanical checks

Run these in order. Each step may produce fixes that the next step validates.

#### 2a. Format

```bash
npm run format
```

**Action:** This is idempotent. Just run it.

#### 2b. Typecheck

```bash
npm run typecheck
```

**Action:** Fix all errors in changed files. If an error is in an unchanged file, mention it but don't fix it unless it was caused by your changes.

#### 2c. Lint

Lint only the changed files to keep output focused. Get the file list from git and pass them directly:

```bash
# Get changed files (staged + unstaged + untracked), filter to lintable extensions
FILES=$(git diff --name-only HEAD --diff-filter=d && git diff --name-only --cached --diff-filter=d && git ls-files --others --exclude-standard | sort -u | grep -E '\.(ts|tsx|js|jsx)$')

# Lint only those files
npx oxlint $FILES
```

If this fails (e.g., too many files or oxlint doesn't accept file args in context), fall back to `npm run lint` and manually filter the output to changed files.

**Warnings are not noise.** The goal is to reduce the warning count with every PR. Treat warnings as things that should be fixed unless there's a specific reason not to — they accumulate into real problems. When presenting warnings to the user, frame them as "these should be fixed; which do you want to skip?" rather than "these are optional; which do you want to fix?"

**Whole-file scope for top files.** For the **top 7 most-changed files** in the changeset (by diff size), raise _all_ warnings in the entire file — not just warnings on changed lines. Since we're already touching these files heavily, this is the cheapest time to clean them up. For the remaining changed files, only raise warnings on changed or new lines.

**Action:**

1. Run lint with auto-fix first (`npx oxlint --fix $FILES`, or `npm run lint:fix` as fallback)
2. For remaining **errors** in changed files — fix them directly
3. For remaining **warnings** — in top-7 files: all warnings in the whole file; in other files: only warnings on changed lines. Group by rule, present to user via `AskUserQuestion` asking which groups to **skip**. Include the count and a representative example for each group. Fix all groups the user doesn't explicitly skip.

#### 2d. Verify

If Phase 2 made any code changes, re-run format and typecheck to confirm nothing is broken:

```bash
npm run format && npm run typecheck
```

If there are still errors, fix them. Don't loop more than twice — if you can't converge, surface the remaining issues to the user.

---

## Final report

After both phases, give a brief summary:

- What you fixed (grouped by dimension, 1-2 sentences each)
- What the user decided on (reference their choices)
- Any remaining issues you couldn't resolve

Keep it concise. The user can read the diff.

## Guidelines

- **Own the quality.** This skill exists because the user wants you to catch your own mistakes. Be thorough and self-critical.
- **Fix, don't suggest.** Make changes directly unless the issue requires user judgment.
- **Batch questions.** Collect findings per dimension and ask once, not per-issue. Use `AskUserQuestion` with `multiSelect: true` when presenting groups of optional fixes.
- **Scope to the diff.** Don't review or modify code that wasn't part of the uncommitted changes, unless your Phase 1 fixes introduced new issues.
- **Read reference docs if unsure.** The dimension descriptions above summarize the conventions, but if you're uncertain, check the linked doc. Don't guess at conventions.
- **Don't loop endlessly.** Phase 2 verify step runs at most twice. If issues persist, report them.
- **Trust your session context.** You've been writing this code — use what you know about intent and tradeoffs to make better review judgments.
