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
- **Vitest is the default; Expo packages run on Jest** — those packages expose a `vp run jest` script, the root aggregates them via `vp run jest` (`vp run -r --concurrency-limit 1 jest`), and `vp run test:all` runs both Vitest and Jest suites.

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

- Stash, branch, or commit for any reason when not specifically indicated by a User
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
- When you are truly confident in an invariant that is independently verified by robust tests

## Branch Naming

`username/description` (e.g., `ruthmarks/add-fhir-server`, `ruthmarks/migrate-claude-behaviour`)

## Parallel Worktrees (devcontainer)

When running multiple agents in parallel inside the devcontainer, **use the helper script — do not run `git worktree add` directly**:

```bash
.devcontainer/wf-worktree.sh new <branch> [<base>]   # create + vp install
.devcontainer/wf-worktree.sh list
.devcontainer/wf-worktree.sh remove <branch>
```

The script places the worktree at `${workspace}/.worktrees/<branch>` (host-visible via the existing bind mount) and symlinks its `node_modules` to `/data/worktrees/<branch>/node_modules` on the Linux-native `wf-data` volume. That keeps the source files editable from host VSCode while installs hardlink from the shared pnpm store at `/data/pnpm-store` — fast, with ~1× total disk cost across worktrees.

The `node_modules/` segment in the symlink target is load-bearing: Node canonicalizes symlinks during require resolution, so the realpath chain has to contain a literal `node_modules/` ancestor — otherwise scoped optional deps like `@voidzero-dev/vite-plus-<platform>` fail to resolve and `vp install`'s postinstall crashes.

Calling `git worktree add` directly will either dump dependencies onto the slow macOS↔Linux bind mount or skip the shared-store hardlinking. The host's `node_modules` for the main checkout is unaffected — it stays in its own Docker volume.

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
- [Dependency Sync How-To](./docs/Expo/Dependency%20Sync%20How-To.md) — Catalog + peer-range conventions for Expo/RN packages
- [Version Override Explanation](./docs/Dependencies/Version%20Override%20Explanation.md) — Why `pnpm.overrides` exists and when to add/remove one

## Commands

```bash
vp run dev           # Start the website dev server
vp run ready         # Format, lint, test:all (Vitest + Jest), build (-r) — full pre-PR check
vp test              # Run Vitest across all packages (Vitest projects mode wired in root vite.config.ts)
vp run jest          # Run Jest across Expo packages (vp run -r --concurrency-limit 1 jest)
vp run test:all      # Run Vitest then Jest (full test pass)
vp run test:changed  # Same as test:all but scales fast-check numRuns down for packages unchanged vs origin/main
vp run build -r      # Build the monorepo
vp check             # Format + lint + typecheck
vp install           # Install/sync dependencies (run after pulling)
```

<!-- markdownlint-disable no-bare-urls -->
<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.

<!--VITE PLUS END-->
