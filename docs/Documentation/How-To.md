# Documentation How-To

How to write, name, place, and maintain docs in this project. For background, see the [Documentation Explanation](./Explanation.md).

## Pick the Kind

| Reader wants to...               | Write a...      |
| -------------------------------- | --------------- |
| Learn by doing a guided exercise | **Tutorial**    |
| Accomplish a specific goal       | **How-To**      |
| Look up a fact or spec           | **Reference**   |
| Understand why something works   | **Explanation** |

If a doc does two of these, split it and link the halves.

## Name and Place It

**Name:** Space-separated title case, ending in the kind. `Design How-To.md`, `FHIR Resources Reference.md`.

**Place:** Near the code it describes. The test: would `git diff` show the doc alongside the code it covers?

**Exempt files** (no kind suffix): README.md, CONTRIBUTING.md, AGENTS.md.

## Write It

**Tutorials:** State what the reader will build. Walk through every step. Show what success looks like. Link to Explanations for depth.

**How-Tos:** Goal first. Steps next. Cover common variations. Link to Explanations for background, References for details.

**References:** Tables, headings, definition lists. Complete and precise. Mirror the structure of what you're documenting.

**Explanations:** Context and rationale. Trade-offs and alternatives. Link to How-Tos for steps, References for specifics.

**All docs:** Link to related docs liberally. Prefer linking over duplicating — duplicated content drifts. Assume the reader is competent; omit anything obvious from context. Shorter docs get read and maintained.

## Maintain Docs

**Update** when you change behavior a doc describes, add a pattern to an existing doc's scope, or notice a doc is wrong.

**Create** when you build something non-obvious (Explanation), establish a repeatable workflow (How-To), create a new API/schema surface (Reference), or want to onboard someone hands-on (Tutorial).

**Skip** when the code is self-explanatory, an existing doc covers it, or the info is only relevant now (use a comment or commit message).

**Doc comments** are separate from `.md` docs — every exported symbol should have a TSDoc comment regardless of whether a `.md` doc exists. See the [Doc Comments Reference](./Doc%20Comments%20Reference.md) for conventions.

## For AI Agents

Check for docs in and near folders you're working in. The kind suffix tells you what to expect: Explanations give context before changes; How-Tos give steps; References give specs.

After completing work, update any nearby docs that describe changed behavior. When creating docs, follow the naming and placement rules above and link from existing docs.

AGENTS.md files are agent configuration, not documentation. They should be short, reference real docs for details, and contain only what every agent run needs.

## Further Reading

- [Documentation Explanation](./Explanation.md) — Why docs are organized into four kinds
- [Documentation Reference](./Reference.md) — Quick-lookup rules
- [Doc Comments Reference](./Doc%20Comments%20Reference.md) — TSDoc conventions for in-code documentation
