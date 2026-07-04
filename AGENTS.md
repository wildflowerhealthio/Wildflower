<!-- markdownlint-disable MD025 -->
<!-- The Vite+-managed block at the bottom emits its own H1; suppressing the multiple-H1 rule for this file rather than editing inside the markers. -->

# AGENTS.md — Wildflower

Read [AGENTS Explanation](./docs/Agents/Explanation.md) for what this file is and how to maintain it.

## Critical Rules

- **Node.js 26+ required** (`engines` in `package.json`)
- **Vite+ owns the toolchain** — drive everything through `vp`. Never invoke `pnpm`, `npm`, or `yarn` directly. See the Vite+ block at the bottom of this file for command surface and pitfalls.
- **Test utilities import from `vite-plus/test`**, not `vitest`
- **Slices must respect their layering** — `<name>-core` is the pure layer; adapters (`-react` browser UI, `-rust` native/server, `-tauri`/`-tauri-rust` Tauri host, `-node`, `-web`) may import from `-core`, never the reverse. Some slices (`persistence`, `scopes`) are Rust-only with no `-core`. See [slices/AGENTS.md](./slices/AGENTS.md).
- **Changes MUST include corresponding test updates**
- **Vitest (via Vite+) is the test runner** — `vp test` runs the suite across all packages.

### Agents MUST read relevant docs before certain tasks

- [Testing](./docs/Testing/Testing%20Reference.md)
  - Use the `/javascript-testing-expert` slash command when writing or reviewing tests. It enforces project testing standards including property-based testing with fast-check and guards against indeterministic test code.
  - Supplement with [Unit Testing](./docs/Testing/Unit%20Testing%20How-To.md) and [Property Testing](./docs/Testing/Property%20Testing%20Reference.md) if needed

- [Doc Comments](./docs/Documentation/Doc%20Comments%20Reference.md)

- [Review Standards](./docs/Agents/Review%20Standards%20Reference.md) — **MUST read before opening any PR**

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

Requires **git 2.48+** — the script uses `git worktree add --relative-paths`, which landed in that release. The devcontainer image ships a newer git; on older hosts `wf-worktree.sh new` fails fast with the version requirement instead of git's opaque "unknown option" message. The **host** git must also be **2.48+**: the first `--relative-paths` worktree writes `extensions.relativeWorktrees = true` into the shared `.git/config`, after which older git refuses to operate on the repo at all (`fatal: unknown repository extension found: relativeworktrees`) — even after the worktree is removed.

The script places the worktree at `${workspace}/.worktrees/<branch>` (host-visible via the existing bind mount) and symlinks its `node_modules` to `/data/worktrees/<branch>/node_modules` on the Linux-native `wf-data` volume. That keeps the source files editable from host VSCode while installs hardlink from the shared pnpm store at `/data/pnpm-store` — fast, with ~1× total disk cost across worktrees.

The `node_modules/` segment in the symlink target is load-bearing: Node canonicalizes symlinks during require resolution, so the realpath chain has to contain a literal `node_modules/` ancestor — otherwise scoped optional deps like `@voidzero-dev/vite-plus-<platform>` fail to resolve and `vp install`'s postinstall crashes.

Cargo's `target/` is redirected per-checkout to `/data/cargo-target/main` (for the main checkout, set up by `postCreateCommand.sh`) or `/data/cargo-target/worktrees/<branch>` (for worktrees, set up by `wf-worktree.sh`) via a generated `.cargo/config.toml`. Same volume, same rationale as `node_modules`: keep the thousands of small files cargo writes during `cargo check`/`cargo build` off the slow macOS↔Linux bind mount. The `.cargo/` directory is gitignored; rebuilding the container regenerates the config. Host-side `cargo` (run from macOS directly) is unaffected — no `.cargo/config.toml` is written on the host.

Calling `git worktree add` directly will either dump dependencies onto the slow macOS↔Linux bind mount or skip the shared-store hardlinking, and it will not set up the per-worktree cargo target dir. The host's `node_modules` for the main checkout is unaffected — it stays in its own Docker volume.

## Documentation

All docs follow the [four-kinds convention](./docs/Documentation/Explanation.md). After making changes, update nearby docs that describe changed behavior. See [Documentation How-To](./docs/Documentation/How-To.md).

## Agent Knowledge

- Read [Agent Strategies](./docs/Agents/Strategies.md) at session start — curated lessons on context management, handoff docs, and large refactors
- Skim recent entries in the [Learnings Inbox](./docs/Agents/Learnings%20Inbox.md)
- When you discover something non-obvious, append it to the Learnings Inbox
- SHOULD NOT edit Strategies.md directly — learnings go through the inbox

## Key References

- [Effect Patterns Reference](./docs/Effect/Patterns%20Reference.md) — Repository pattern, generators, error wrappers, Layers
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Dev setup, code style, formatting, git workflow
- [docs/Testing/](./docs/Testing/Testing%20Reference.md) — Property testing, unit testing, React testing, integration testing
- [Documentation Reference](./docs/Documentation/Reference.md) — Naming rules for docs
- [Version Override Explanation](./docs/Dependencies/Version%20Override%20Explanation.md) — Why `pnpm.overrides` exists and when to add/remove one

## Commands

```bash
vp run dev           # Start EVERY package's dev server in parallel (vp run -r --parallel dev), not just website
vp run ready         # fmt + lint + lint:comments + lint:docs + pack + test:all — full pre-PR check (≈ CI's TS-side gates)
vp test              # Run Vitest across all packages (Vitest projects mode wired in root vite.config.ts)
vp run test:all      # Run the full Vitest test pass
vp run test:changed  # Same as test:all but scales fast-check numRuns down for packages unchanged vs origin/main
vp run pack          # Build the monorepo (vp run --cache -r build; there is no root `build` script)
vp check             # Format + lint + typecheck
vp install           # Install/sync dependencies (run after pulling or editing any package.json)
```

## CI gates and pre-PR parity

`vp run ready` covers the TypeScript side of CI. The full gate set (see `.github/workflows/`):

- **TS format/lint/typecheck/test** — `vp check` + `vp test`. The enforced lint/format rules are oxlint+oxfmt, configured in `vite.config.ts` under the `lint:`/`fmt:` keys — **not** `eslint.config.mjs`, which runs only the informational TSDoc check (`lint:comments`, `continue-on-error`). Editing eslint config never fixes a lint failure.
- **Rust fmt + clippy (`-D warnings`) + nextest** — `./scripts/checks/rust.sh` is the canonical Rust check; both the git hooks and CI (`ci-rust.yml`, `ci-rust-tauri.yml`) call it. It self-skips when `cargo` is absent, so a frontend-only change stays green locally while CI still gates it on PRs.
- **cargo-deny** (licenses/advisories, `deny.toml`) gates new Rust deps.
- **markdownlint-cli2** on all `.md` — run locally via `vp run lint:docs`.
- **OpenAPI Rust↔TS drift** (`api-sync.yml`) — a committed snapshot per slice. Regenerate a stale one with `UPDATE_OPENAPI=1 cargo test -p <slice>-rust openapi_spec_snapshot_is_up_to_date`; the TS half is `vp test openapi-drift`.

## Rust / Tauri

Polyglot repo: a 15-member Cargo workspace (~207 `.rs` files) alongside the TS packages. `rust-toolchain.toml` pins the toolchain, auto-downloaded on the first `cargo` command (multi-minute, one-time — don't kill it). `Cargo.toml` sets `unsafe_code = "forbid"`, clippy runs with `-D warnings`, and cargo-deny gates new deps/licenses. Run all Rust checks via `./scripts/checks/rust.sh` (see CI gates above).

## Fresh container bootstrap

`.devcontainer/postCreateCommand.sh` installs a **global** `vp` (latest/unpinned) then runs `vp install`. The workspace pins vite-plus lower via the catalog, so for `vp test` in jsdom packages use the workspace-local binary `node_modules/.bin/vp` — the global `vp`'s bundled vitest can't resolve jsdom. Re-run `vp install` after any `package.json` edit.

## Git hooks

Installed via `vp config` (the `prepare` script), so a plain `git commit`/`git push` triggers real work — don't kill one that looks "hung":

- **pre-commit** runs `vp run pack; vp staged`, where `vp staged` maps `*` → `vp check --fix`, `*.md` → `lint:docs`, `*.{rs,toml}` → `rust.sh pre-commit`.
- **pre-push** runs `vp run pack; vp run test:changed; ./scripts/checks/rust.sh pre-push`.

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
