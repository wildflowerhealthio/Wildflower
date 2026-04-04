# rev

Revise code to better match project conventions. Takes a keyword for the convention area.

**Keyword:** $ARGUMENTS

## Keywords

- **property** — Property-based testing conventions (opaque arbitraries, verified mocks, MECE chains, algebraic properties). Reference: `docs/Testing/Property Testing Reference.md`
- **testing** — General testing conventions (property-first approach, MECE structure, dense test files, clear names, Effect testing patterns). Reference: `docs/Testing/Testing Reference.md` and `docs/Testing/Unit Testing How-To.md`
- **pipeline** — Pipelined, compositional Effect style (generators, pipe, chaining, composed over monolithic). Reference: `docs/Effect/Patterns Reference.md`
- **comments** — TSDoc doc comments (section ordering, every export documented, front-load the contract, don't repeat type signatures). Reference: `docs/Documentation/Doc Comments Reference.md`
- **effect** — Broader Effect-TS conventions (repository pattern, specific error classes, Layer composition, Schema branding). Reference: `docs/Effect/Patterns Reference.md`

## Steps

1. **Determine what to revise.** In priority order:
   - **IDE selection** — if the user has code highlighted, revise that
   - **$ARGUMENTS file path** — if the keyword is followed by a file path (e.g., `property src/foo.test.ts`), revise that file
   - **Recent changes** — fall back to `git diff` to find code you recently wrote or modified

   If the target code doesn't seem relevant to the keyword (e.g., running `/rev comments` but the selected code is a test file with no exports), use `AskUserQuestion` to ask whether to apply the convention to the target anyway, or to suggest other files from recent work that would benefit more.

2. **Revise the code** to conform to the conventions in the reference doc. Be opinionated — this skill exists because the user wants their style applied, not a gentle suggestion. Make the changes directly.

3. **Briefly explain what you changed and why**, referencing specific conventions from the reference doc. Keep it to 2-3 sentences.

## Guidelines

- **Consult the reference doc if unsure.** The keyword descriptions above cover the key conventions, but if you're uncertain about a specific rule or haven't read the doc this session, check it. Don't re-read docs you've already internalized.
- **Be opinionated, not tentative.** The user invoked this because they want the code revised. Make the changes.
- **Use judgment on scope.** If revising one function reveals that surrounding code has the same issue, fix it. But don't snowball into a full-file rewrite unless the user asked for it.
- **If the keyword is ambiguous or missing**, ask the user which convention area they mean. Don't guess.
