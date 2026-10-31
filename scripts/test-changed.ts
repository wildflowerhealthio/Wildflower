#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// `vp run test:changed`: the tests CI's plan runs for this branch, in one
// local `vp test run` at the plan's fast-check run scale. The selection is
// `scripts/ci/test-shards.ts`'s — the projects of the packages the branch's
// changes reach plus `scripts`, or every project when a root config file or a
// file outside every package other than Markdown changed — over the commits
// since `origin/main` and any uncommitted or untracked work.
import { Console, Effect } from 'effect'

import { loadAffectedPackages } from './affected-packages.ts'
import { loadVitestProjects, runScaleFor, selectionFor, selectsProject } from './ci/test-shards.ts'
import { isEntrypoint } from './entrypoint.ts'

/** scripts/ sits one level under the repo root. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** `count` and `noun`, plural unless `count` is 1. */
const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const main = Effect.gen(function* () {
  const projects = yield* loadVitestProjects(REPO_ROOT)
  const { packages, affectedPackages } = yield* loadAffectedPackages(REPO_ROOT)
  const selection = selectionFor(affectedPackages, packages)
  const runScale = runScaleFor(selection)
  // Every project runs when no `--project` narrows the run.
  const selected =
    selection._tag === 'AllProjects'
      ? []
      : projects
          .filter((project) => selectsProject(selection, project))
          .map((project) => project.name)
  yield* Console.error(
    selection._tag === 'AllProjects'
      ? `test:changed: every project at run scale ${runScale} (${selection.reason})`
      : `test:changed: ${counted(selected.length, 'project')}, for ${counted(selection.affectedPackageDirs.length, 'affected package')}`
  )
  const { status, error } = yield* Effect.sync(() =>
    spawnSync('vp', ['test', 'run', ...selected.flatMap((name) => ['--project', name])], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, FC_RUN_SCALE: String(runScale) },
    })
  )
  if (error) yield* Console.error(`test:changed: could not start vp: ${error.message}`)
  process.exitCode = status ?? 1
})

if (isEntrypoint(import.meta.url)) await Effect.runPromise(Effect.orDie(main))
