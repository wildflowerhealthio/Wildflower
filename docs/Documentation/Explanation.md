# Documentation Explanation

We use a model from [Divio](https://docs.divio.com/documentation-system/) that separates documentation into four kinds. Each kind serves a different reader mindset. Mixing them produces docs that serve nobody well.

## The Four Kinds

**Tutorial** — Learning-oriented. Walks the reader through a guided exercise to produce a concrete result. Tells them exactly what to do; avoids choices and deep explanations.

**How-To** — Goal-oriented. Answers "how do I accomplish X?" with steps. Assumes the reader already has context. Links to Explanations for background, References for details.

**Reference** — Information-oriented. Describes the system as-is: APIs, schemas, rules. Structured for scanning, not reading. Accurate and terse.

**Explanation** — Understanding-oriented. Answers "why?" and "how does this fit together?" Provides context, trade-offs, and mental models. Links to How-Tos for steps, References for specifics.

## How This Applies Here

**Naming:** Every doc file (except README.md, CONTRIBUTING.md, AGENTS.md) is a markdown file named in space-separated title case ending in one of the four kinds. Example: `Design How-To.md`.

**Co-location:** Docs live near the code they describe. If changing code would make a doc wrong, they should be in the same folder.

**Cross-referencing:** Link liberally between docs. Linking is cheap; duplicating content drifts.

**Exempt files:** README.md, CONTRIBUTING.md, and AGENTS.md live outside the four-kinds system. They have conventional names that tools recognize and should be kept minimal.

**Doc comments:** In-code TSDoc comments are a fifth documentation surface — they live on exported symbols and are consumed through IDE hover windows and by AI agents. They follow their own conventions described in the [Doc Comments Reference](./Doc%20Comments%20Reference.md). The four-kinds system applies to `.md` files; doc comments complement them by documenting the API contract right where it's used.

## Writing Style

Assume the reader is competent. State what they need to know without over-explaining obvious implications. If a point is already clear from context, omit it. Brevity is a feature — shorter docs get read and maintained.

## Further Reading

- [Documentation How-To](./How-To.md) — How to write and maintain docs in this project
- [Documentation Reference](./Reference.md) — Quick-lookup rules
- [Doc Comments Reference](./Doc%20Comments%20Reference.md) — TSDoc conventions for in-code documentation
- [The Divio documentation system](https://docs.divio.com/documentation-system/) — The original framework
