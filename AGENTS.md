<!-- markdownlint-disable MD025 -->
<!-- The Vite+-managed block at the bottom emits its own H1; suppressing the multiple-H1 rule for this file rather than editing inside the markers. -->

# AGENTS.md — Wildflower

Read [AGENTS Explanation](./docs/Agents/Explanation.md) for what this file is and how to maintain it.

## Critical Rules

- **Node.js 22.12+ required** (`engines` in `package.json`)
- **Vite+ owns the toolchain** — drive everything through `vp`. Never invoke `pnpm`, `npm`, or `yarn` directly. See the Vite+ block at the bottom of this file for command surface and pitfalls.
- **Test utilities import from `vite-plus/test`**, not `vitest`
- **Slices must respect their layering** — `slices/<name>/<name>-core` is the pure layer; `-web`, `-node`, `-react-native`, `-expo` are platform adapters that may import from `-core` but not vice-versa
- **Changes MUST include corresponding test updates**

### Agents MUST read relevant docs before certain tasks

- [Testing](./docs/Testing/Testing%20Reference.md)
  - Use the `/javascript-testing-expert` slash command when writing or reviewing tests. It enforces project testing standards including property-based testing with fast-check and guards against indeterministic test code.
  - Supplement with [Unit Testing](./docs/Testing/Unit%20Testing%20How-To.md) and [Property Testing](./docs/Testing/Property%20Testing%20Reference.md) if needed

- [Doc Comments](./docs/Documentation/Doc%20Comments%20Reference.md)

### Agents SHOULD Clarify before building or planning

Before starting any task, pause and think about the request, then ask clarifying questions to minimize guessing and confirm shared understanding. The last question should be: "Do you think I understand well enough to start?" If the user says to ask more, do another think-and-ask cycle. Err on the side of asking too many questions.

### Claude SHOULD use AskUserQuestion

Split large batches of questions over multiple asks

### Agents MUST ask for guidance before expanding scope

While completing tasks may be inclined to

- Stash code to check if an error is new
- Create new branches or commits
- Search online for information
- Writing code to verify the behaviour of other modules

You MUST consult with the user before doing these or similar actions.
They may have an answer or they may not want you to engage in that behaviour.

### Agents SHOULD NOT silently resolve judgment calls or spiral into obscure problem

The user brings domain knowledge, intent, and taste. They also often have a months long context window, and may recall things only past agents knew.
Don't silently resolve judgment calls or spiral into obscure problems — surface them so the human can contribute what they're best at.

### Agents SHOULD NOT guess at user intent or code state

If you've taken 3+ investigative actions on a sub-problem without converging, or you're about to work around something that smells like an accidental inconsistency, **stop and present the issue to the user**. Also surface: ambiguous naming, conflicting patterns across files, anything where you're choosing between two plausible interpretations. The trigger is: _"Am I guessing?"_ — if yes, ask.

### Agents SHOULD NOT use `any`, `@ts-ignore`, `@ts-expect-error`, unsafe casts

Code should be type-safe by design, not by assertion. If you encounter a situation where a cast seems unavoidable, surface it to the user in the response message (or PR description) with an explanation of why, so they can decide whether the design needs rethinking.

There do exist some, narrow exceptions to the rule:

- Type parameters within type parameters with complex structures
- When used in test files in such a way that it doesn't materially reduce confidence in the test
- Deeply technical, foundation code, that can't reasonably typecheck that is meaningfully tested in other ways
- The phantom-id `as unknown as Layer.Layer<...>` cast used by `*ApiHandlersFor<ParentId>()` helpers when composing `HttpApi` groups across packages — see [HttpApi Composition How-To](./docs/Effect/HttpApi%20Composition%20How-To.md)

## Branch Naming

`username/description` (e.g., `ruthmarks/add-fhir-server`, `ruthmarks/migrate-claude-behaviour`)

## Documentation

All docs follow the [four-kinds convention](./docs/Documentation/Explanation.md). After making changes, update nearby docs that describe changed behavior. See [Documentation How-To](./docs/Documentation/How-To.md).

## Agent Knowledge

- Read [Agent Strategies](./docs/Agents/Strategies.md) at session start — curated lessons on context management, handoff docs, and large refactors
- Scan [Learnings Inbox](./docs/Agents/Learnings%20Inbox.md) for recent relevant entries
- When you discover something non-obvious, append it to the Learnings Inbox
- SHOULD NOT edit Strategies.md directly — learnings go through the inbox

## Key References

- [Effect Patterns Reference](./docs/Effect/Patterns%20Reference.md) — Repository pattern, generators, error wrappers, Layers
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Dev setup, code style, formatting, git workflow
- [docs/Testing/](./docs/Testing/Testing%20Reference.md) — Property testing, unit testing, React testing, integration testing
- [Documentation Reference](./docs/Documentation/Reference.md) — Naming rules for docs

## Commands

```bash
vp run dev           # Start the website dev server
vp run ready         # Format, lint, test (-r), build (-r) — full pre-PR check
vp run test -r       # Run tests across all packages
vp run build -r      # Build the monorepo
vp check             # Format + lint + typecheck
vp install           # Install/sync dependencies (run after pulling)
```

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ built-in commands (`vp dev`, `vp build`, `vp test`, etc.) always run the Vite+ built-in tool, not any `package.json` script of the same name. To run a custom script that shares a name with a built-in command, use `vp run <script>`. For example, if you have a custom `dev` script that runs multiple services concurrently, run it with `vp run dev`, not `vp dev` (which always starts Vite's dev server).
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## CI Integration

For GitHub Actions, consider using [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp) to replace separate `actions/setup-node`, package-manager setup, cache, and install steps with a single action.

```yaml
- uses: voidzero-dev/setup-vp@v1
  with:
    cache: true
- run: vp check
- run: vp test
```

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
<!--VITE PLUS END-->
