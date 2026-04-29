# Documentation Reference

Quick-lookup rules for documentation in this project. For background, see the [Documentation Explanation](./Explanation.md). For how to apply these rules, see the [Documentation How-To](./How-To.md).

## The Four Kinds

| Kind            | Purpose                | Reader mindset                 | Style                   |
| --------------- | ---------------------- | ------------------------------ | ----------------------- |
| **Tutorial**    | Learning by doing      | "I want to learn"              | Guided exercise         |
| **How-To**      | Accomplishing a goal   | "I need to do X"               | Numbered steps          |
| **Reference**   | Looking up facts       | "What exactly is X?"           | Structured for scanning |
| **Explanation** | Building understanding | "Why does this work this way?" | Discursive, contextual  |

## File Naming Rules

| Rule                             | Example                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| Space-separated title case       | `Effect Patterns`, not `effect-patterns`                                |
| Ends with the kind               | `Effect Patterns Explanation.md`                                        |
| Markdown format                  | Always `.md`                                                            |
| Names rely on folder for context | `Design How-To.md` in `apps/frontend/`, not `Frontend Design How-To.md` |
| Folder names: title case         | `docs/Architecture/`, not `docs/architecture/`                          |

### Valid Kind Suffixes

- `Explanation`
- `How-To`
- `Reference`
- `Tutorial`

## Exempt Files

These files don't follow the four-kinds naming convention:

| File              | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `README.md`       | Project/package overview and entry point   |
| `CONTRIBUTING.md` | Development setup and contribution process |
| `AGENTS.md`       | AI agent configuration and context         |

## Placement Rules

| Scope                 | Location                                                    |
| --------------------- | ----------------------------------------------------------- |
| Whole project         | Repository root                                             |
| A top-level directory | Top of that directory (`apps/`, `domain/`)                  |
| A specific package    | Package root (`domain/clinical-domain/`)                    |
| A module or feature   | Module folder (`apps/frontend/app/modules/interview-call/`) |

**Principle:** Put the doc where `git diff` would show it alongside the code it describes.

## In-Code Documentation

Exported symbols use TSDoc comments — a separate surface from `.md` docs. See the [Doc Comments Reference](./Doc%20Comments%20Reference.md) for tag usage, section ordering, and style rules. Enforced via `eslint-plugin-tsdoc`.

## Cross-referencing

- Link using relative markdown paths: `[Design How-To](./Design%20How-To.md)`
- Prefer linking over duplicating content
- Every Explanation should link to related How-Tos and References
- Every How-To should link to the Explanation that provides background
- Every Reference should link to the Explanation that provides rationale

## AGENTS.md Files

| Rule              | Detail                                          |
| ----------------- | ----------------------------------------------- |
| Location          | Repository root, plus subdirectories as needed  |
| Content           | Short, mostly references to documentation files |
| Not documentation | Configuration for AI agents, not human docs     |
| No duplication    | Link to docs, don't copy their content          |
