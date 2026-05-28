import { FileSystem } from '@effect/platform'
import { Effect, Option } from 'effect'
import { Directory, File } from 'expo-file-system'
import { fileUri, inspect, systemError, trySystem } from './helpers.ts'

/**
 * `stat` on a `Directory` returns `size` as the recursive byte sum of the
 * subtree (per expo-file-system's docs) — callers who only want `type`/`mtime`
 * still pay a full subtree walk, so avoid `stat` on directories in hot paths.
 * A `null` `Directory.size` (read failure) is surfaced as a typed
 * `SystemError` so permission errors don't silently masquerade as `size: 0`.
 */
const stat: FileSystem.FileSystem['stat'] = (path) =>
  Effect.flatMap(inspect('stat', path), (info) => {
    if (!info.exists) {
      return Effect.fail(systemError('stat', path, 'NotFound', null))
    }
    if (info.isDirectory === true) {
      return trySystem('stat', path, 'Unknown', () => new Directory(fileUri(path))).pipe(
        Effect.flatMap((dir) => {
          if (dir.size === null) {
            return Effect.fail(
              systemError(
                'stat',
                path,
                'PermissionDenied',
                null,
                'Directory.size returned null (unreadable)'
              )
            )
          }
          return Effect.succeed<FileSystem.File.Info>({
            type: 'Directory',
            mtime: Option.none(),
            atime: Option.none(),
            birthtime: Option.none(),
            dev: 0,
            ino: Option.none(),
            mode: 0,
            nlink: Option.none(),
            uid: Option.none(),
            gid: Option.none(),
            rdev: Option.none(),
            size: FileSystem.Size(dir.size),
            blksize: Option.none(),
            blocks: Option.none(),
          })
        })
      )
    }
    return trySystem('stat', path, 'Unknown', () => new File(fileUri(path))).pipe(
      Effect.map((file): FileSystem.File.Info => {
        const mtimeMs = file.modificationTime
        const birthMs = file.creationTime
        return {
          type: 'File',
          mtime: mtimeMs == null ? Option.none() : Option.some(new Date(mtimeMs)),
          atime: Option.none(),
          birthtime: birthMs == null ? Option.none() : Option.some(new Date(birthMs)),
          dev: 0,
          ino: Option.none(),
          mode: 0,
          nlink: Option.none(),
          uid: Option.none(),
          gid: Option.none(),
          rdev: Option.none(),
          size: FileSystem.Size(file.size),
          blksize: Option.none(),
          blocks: Option.none(),
        }
      })
    )
  })

export { stat }
