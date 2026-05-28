/**
 * Test-only helpers shared across the per-method test files in this folder.
 * Keeping them here (rather than re-declaring per file) avoids subtle
 * divergence as the assertion patterns evolve.
 */
import { FileSystem } from '@effect/platform'
import { Cause, Effect, Exit, Option, pipe } from 'effect'

import type * as ExpoFileSystemModule from '../../expo-file-system.ts'

// `require` (not `import`) matches sibling test files where mock factories
// capture module-local variables that ES imports would race against.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const ExpoFileSystem = require('../../expo-file-system') as typeof ExpoFileSystemModule

/**
 * Provide the Expo `FileSystem` layer to a body that consumes the service,
 * then run to a Promise. Keeps test bodies focused on the per-method
 * assertions rather than the boilerplate of yielding the tag.
 */
const runFs = <A, E>(body: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>): Promise<A> => {
  const program = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* body(fs)
  }).pipe(Effect.provide(ExpoFileSystem.layer))
  return Effect.runPromise(program)
}

/**
 * Extract the typed failure from an Effect that's expected to fail. Throws
 * if the Effect succeeds or dies — tests should fail loudly on either.
 */
const expectFailureCause = async <A, E>(eff: Effect.Effect<A, E>): Promise<E> => {
  const exit = await Effect.runPromiseExit(eff)
  return pipe(exit, Exit.causeOption, Option.flatMap(Cause.failureOption), Option.getOrThrow)
}

export { ExpoFileSystem, runFs, expectFailureCause }
