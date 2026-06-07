import { type FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { Directory } from 'expo-file-system'
import * as Telemetry from '../../telemetry.ts'
import { fileUri, inspect, instrument, systemError, trySystem } from './helpers.ts'

const makeDirectory: FileSystem.FileSystem['makeDirectory'] = (path, options) => {
  const recursive = options?.recursive ?? false
  // Non-recursive `mkdir` on Node's adapter surfaces `EEXIST` as
  // `reason: 'AlreadyExists'`. expo-file-system's `Directory.create()` throws
  // an opaque message in this case which `trySystem` would map to `Unknown`,
  // diverging from the Node contract. Pre-check via `Paths.info` and fail
  // with the matching reason so cross-platform callers pattern-matching on
  // `e.reason === 'AlreadyExists'` behave consistently.
  const effect = !recursive
    ? Effect.flatMap(inspect('makeDirectory', path), (info) => {
        if (info.exists) {
          return Effect.fail(
            systemError(
              'makeDirectory',
              path,
              'AlreadyExists',
              null,
              'A file or directory already exists at this path'
            )
          )
        }
        return trySystem('makeDirectory', path, 'Unknown', () => {
          new Directory(fileUri(path)).create({ intermediates: false, idempotent: false })
        })
      })
    : trySystem('makeDirectory', path, 'Unknown', () => {
        // `recursive: true` on the Effect surface maps to BOTH `intermediates`
        // (creates parents) AND `idempotent` (no-op if already exists), matching
        // Node's `fs.mkdir(..., { recursive: true })` semantics. expo-file-system
        // separates the two flags but the Effect contract treats them as one.
        new Directory(fileUri(path)).create({ intermediates: true, idempotent: true })
      })
  return effect.pipe(
    instrument('makeDirectory', Telemetry.FileSystem.MakeDirectory.Span.Name, path)
  )
}

export { makeDirectory }
