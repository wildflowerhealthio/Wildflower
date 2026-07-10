# Comment Pruning How-To

How to audit a branch's diff and cut comment bulk before pushing. The goal is fewer, denser comments — concepts named in code, shared explanations lifted into docs, and nothing left that a reader has to skim past. For the conventions the surviving comments should follow, see the [Doc Comments Reference](./Doc%20Comments%20Reference.md).

## Scope the Audit

Audit the **entire diff of the branch against its common ancestor with `main`**, not just the comments a single file added:

```bash
git diff "$(git merge-base HEAD origin/main)"...HEAD
```

Consider every comment the diff touches a candidate. You may edit any file already in the diff. Do **not** edit files outside the diff — the one exception is collecting their comments into a shared doc, when in-diff files reference the same concept those files explain.

## Pass 1 — Deduplicate Into Docs

Before touching individual comments, read the diff as a whole and find concepts explained in more than one place, or explained at length inline where a doc would serve better. Write those up first:

- A concept repeated across comments becomes one doc that each site links to. Prefer [referencing a doc](./How-To.md) to repeating it.
- A long inline explanation of _why_ a module works the way it does becomes a module-level block or a `.md` [Explanation](./Explanation.md), not a wall of `//`.

Name and place any new doc per the [Documentation How-To](./How-To.md). Then rewrite the comments that motivated it to link to it rather than restate it.

## Pass 2 — Scrutinize Each Comment

With the shared explanations lifted out, take a detail pass over what remains:

| Rule                           | What to do                                                                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blocks over ten lines**      | Treat as a defect until proven otherwise. It is a candidate for a doc, a named function, or deletion. A genuinely gotcha-heavy small utility may keep a long `@remarks` (see [Doc Comments Reference](./Doc%20Comments%20Reference.md)) — but justify it. |
| **Inaccurate comments**        | Remove them. A comment that contradicts the code is worse than none. Reconcile against the diff — command lists, counts, and "what this does NOT do" claims drift silently.                                                                               |
| **Name, don't narrate**        | Prefer an expressive name or a new variable/function that gives a concept its name over a comment explaining an unnamed expression.                                                                                                                       |
| **Lift long explanations out** | Prefer a module-level block or a reference doc over a long inline explanation.                                                                                                                                                                            |
| **Reference, don't repeat**    | Prefer linking to a doc over restating its contents.                                                                                                                                                                                                      |
| **Doc-comment style**          | Prefer `/** … */` doc comments over `//` so the text surfaces on hover and to AI agents. Follow the [Doc Comments Reference](./Doc%20Comments%20Reference.md) section ordering.                                                                           |

### Test Comments Are the Exception

A test comment explaining _intent_ is necessary, not bulk. A test asserts an expectation that comes from outside the code under test, so it cannot be fully self-documenting — the comment carries the intent the assertions can't. Keep these; apply the rules above only to how tightly they're written.

## See Also

- [Doc Comments Reference](./Doc%20Comments%20Reference.md) — conventions the surviving comments follow, including present-tense reconciliation against the diff
- [Documentation How-To](./How-To.md) — naming and placing the docs Pass 1 produces
- [Review Standards Reference](../Agents/Review%20Standards%20Reference.md) — the broader set of pre-push self-checks
