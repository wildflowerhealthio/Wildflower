# AGENTS Explanation

AGENTS.md files provide context to AI agents working in this codebase. They are **not documentation** — they are configuration.

## What Goes in AGENTS.md

- **Guardrails**: rules that must not be broken
- **Traps**: non-obvious facts that would cause mistakes (e.g., "heading-6 is the largest heading in Tundra")
- **Links**: pointers to real documentation for context and detail

## What Does Not Go in AGENTS.md

- Explanations of why things work the way they do → write an Explanation doc
- Step-by-step workflows → write a How-To doc
- API specs, naming rules, config options → write a Reference doc
- Content that duplicates existing documentation → link to it instead

## Structure

There is one AGENTS.md at the repository root (loaded every run) and one in each major directory (loaded when working in that area). Each should be short enough to scan in seconds.

Root AGENTS.md references project-wide docs. Directory-level AGENTS.md files reference docs relevant to that directory.

## Relationship to CLAUDE.md

Claude Code loads CLAUDE.md automatically but does not load AGENTS.md. Each directory has a symlink CLAUDE.md that points to the AGENTS.md. The real content lives in AGENTS.md so it's tool-agnostic.

## See Also

- [Documentation Explanation](../Documentation/Explanation.md) — How docs are organized into four kinds
- [Documentation How-To](../Documentation/How-To.md) — How to write and maintain docs
