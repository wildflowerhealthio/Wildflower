import * as FileSystem from '@effect/platform/FileSystem'
import * as Layer from 'effect/Layer'
import { access } from './access.ts'
import { makeDirectory } from './make-directory.ts'
import { readFile } from './read-file.ts'
import { remove } from './remove.ts'
import { stat } from './stat.ts'
import { unsupportedMethods } from './unsupported.ts'
import { writeFile } from './write-file.ts'

/**
 * Synchronous `expo-file-system` operations surfaced as
 * `FileSystem.FileSystem` so finalizers compose with the surrounding Layer,
 * failures land in the typed error channel, and ops show up in the Effect
 * trace.
 *
 * @remarks
 * Implemented: `access`, `exists` (derived), `stat`, `makeDirectory`,
 * `remove`, `readFile`, `readFileString` (derived), `writeFile`,
 * `writeFileString` (derived).
 *
 * Directly unsupported (`reason: 'BadResource'`): `chmod`, `chown`, `copy`,
 * `copyFile`, `link`, `makeTempDirectory`, `makeTempDirectoryScoped`,
 * `makeTempFile`, `makeTempFileScoped`, `open`, `readDirectory`, `readLink`,
 * `realPath`, `rename`, `symlink`, `truncate`, `utimes`, `watch`. See
 * {@link unsupportedMethods}.
 *
 * Transitively unsupported: `stream` and `sink` are synthesised by
 * `FileSystem.make` from `open` (which always fails) — so `fs.stream(path)`
 * and `fs.sink(path)` surface as "open is not supported."
 *
 * `WriteFileOptions.flag` and `mode` are not honoured (expo-file-system's
 * `File.write` has no equivalent surface): a non-default `flag` fails with
 * `reason: 'BadResource'` rather than silently clobbering; `mode` is
 * dropped.
 */
const make: FileSystem.FileSystem = FileSystem.make({
  ...unsupportedMethods,
  access,
  makeDirectory,
  readFile,
  remove,
  stat,
  writeFile,
})

/** `Layer` providing the Expo-backed `FileSystem.FileSystem`. */
const layer: Layer.Layer<FileSystem.FileSystem> = Layer.succeed(FileSystem.FileSystem, make)

export { make, layer }
