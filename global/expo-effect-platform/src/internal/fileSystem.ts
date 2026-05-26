import * as PlatformError from '@effect/platform/Error'
import * as FileSystem from '@effect/platform/FileSystem'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import { Directory, File, Paths } from 'expo-file-system'

/**
 * Strip the `file://` URI scheme so a bare absolute path can be handed to
 * `expo-file-system`'s `Directory` / `File` constructors (which accept either
 * form, but every other API in `@effect/platform`'s `FileSystem` expects bare
 * paths).
 */
const fileUri = (path: string): string => (path.startsWith('file://') ? path : `file://${path}`)

/**
 * Wrap an arbitrary thrown value as a `PlatformError.SystemError`. Used to
 * convert synchronous `expo-file-system` exceptions (no native error code is
 * exposed to JS) into the typed `FileSystem` failure channel.
 */
const systemError = (
  method: string,
  path: string,
  reason: PlatformError.SystemErrorReason,
  cause: unknown,
  description?: string
): PlatformError.SystemError =>
  new PlatformError.SystemError({
    module: 'FileSystem',
    method,
    reason,
    description: description ?? (cause instanceof Error ? cause.message : 'expo-file-system threw'),
    pathOrDescriptor: path,
    cause,
  })

const notSupported = (method: string, path: string): PlatformError.SystemError =>
  systemError(
    method,
    path,
    'PermissionDenied',
    new Error(`${method} is not supported by expo-effect-platform`),
    `${method} is not supported by expo-effect-platform`
  )

/**
 * `Effect.try` adapter that maps any thrown value to a `SystemError` with the
 * given `method`/`path`. Keeps each call site to a single line.
 */
const trySystem = <A>(
  method: string,
  path: string,
  reason: PlatformError.SystemErrorReason,
  thunk: () => A
): Effect.Effect<A, PlatformError.SystemError> =>
  Effect.try({
    try: thunk,
    catch: (cause) => systemError(method, path, reason, cause),
  })

/**
 * Probe an arbitrary path for existence + kind via `Paths.info`. `isDirectory`
 * is `true` for directories, `false` for files, and `null` when the path does
 * not exist.
 */
const inspect = (
  method: string,
  path: string
): Effect.Effect<{ exists: boolean; isDirectory: boolean | null }, PlatformError.SystemError> =>
  trySystem(method, path, 'Unknown', () => Paths.info(fileUri(path)))

// ---------------------------------------------------------------------------
// FileSystem.FileSystem implementation
// ---------------------------------------------------------------------------

const access: FileSystem.FileSystem['access'] = (path, _options) =>
  Effect.flatMap(inspect('access', path), (info) =>
    info.exists ? Effect.void : Effect.fail(systemError('access', path, 'NotFound', null))
  )

const stat: FileSystem.FileSystem['stat'] = (path) =>
  Effect.flatMap(inspect('stat', path), (info) => {
    if (!info.exists) {
      return Effect.fail(systemError('stat', path, 'NotFound', null))
    }
    if (info.isDirectory === true) {
      return trySystem('stat', path, 'Unknown', () => new Directory(fileUri(path))).pipe(
        Effect.map(
          (dir): FileSystem.File.Info => ({
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
            size: FileSystem.Size(dir.size ?? 0),
            blksize: Option.none(),
            blocks: Option.none(),
          })
        )
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

const makeDirectory: FileSystem.FileSystem['makeDirectory'] = (path, options) =>
  trySystem('makeDirectory', path, 'Unknown', () => {
    const dir = new Directory(fileUri(path))
    // `recursive` on the Effect surface maps to BOTH `intermediates` (creates
    // parents) AND `idempotent` (no-op if already exists), matching Node's
    // `fs.mkdir(..., { recursive: true })` semantics. expo-file-system
    // separates the two flags but the Effect contract treats them as one.
    const recursive = options?.recursive ?? false
    dir.create({ intermediates: recursive, idempotent: recursive })
  })

const remove: FileSystem.FileSystem['remove'] = (path, options) =>
  Effect.flatMap(inspect('remove', path), (info) => {
    if (!info.exists) {
      return options?.force === true
        ? Effect.void
        : Effect.fail(systemError('remove', path, 'NotFound', null))
    }
    return trySystem('remove', path, 'Unknown', () => {
      const uri = fileUri(path)
      if (info.isDirectory === true) {
        // expo-file-system's `Directory.delete()` removes the directory and
        // all contents, matching the Effect contract when `recursive: true`.
        new Directory(uri).delete()
      } else {
        new File(uri).delete()
      }
    })
  })

const writeFile: FileSystem.FileSystem['writeFile'] = (path, data, _options) =>
  trySystem('writeFile', path, 'Unknown', () => {
    const file = new File(fileUri(path))
    if (file.exists) {
      file.delete()
    }
    file.create()
    file.write(data)
  })

const readFile: FileSystem.FileSystem['readFile'] = (path) =>
  Effect.flatMap(inspect('readFile', path), (info) => {
    if (!info.exists) return Effect.fail(systemError('readFile', path, 'NotFound', null))
    return trySystem('readFile', path, 'Unknown', () => new File(fileUri(path)).bytesSync())
  })

/**
 * Synchronous `expo-file-system` operations are surfaced as
 * `FileSystem.FileSystem` so finalizers compose with the surrounding Layer,
 * failures land in the typed error channel, and ops show up in the Effect
 * trace.
 *
 * @remarks
 * Only the operations consumed by the on-device daemons are implemented:
 * `access`, `exists` (derived), `stat`, `makeDirectory`, `remove`,
 * `readFile`, `readFileString` (derived), `writeFile`, `writeFileString`
 * (derived). Unsupported methods (`chmod`, `chown`, `copy`, `link`,
 * `makeTempDirectory`, `open`, `readDirectory`, `readLink`, `realPath`,
 * `rename`, `symlink`, `truncate`, `utimes`, `watch`) fail with a typed
 * `SystemError` carrying `reason: 'PermissionDenied'` and a description
 * that calls out the package, so callers don't silently get a generic
 * `NotFound`.
 */
const make: FileSystem.FileSystem = FileSystem.make({
  access,
  chmod: (path) => Effect.fail(notSupported('chmod', path)),
  chown: (path) => Effect.fail(notSupported('chown', path)),
  copy: (fromPath) => Effect.fail(notSupported('copy', fromPath)),
  copyFile: (fromPath) => Effect.fail(notSupported('copyFile', fromPath)),
  link: (fromPath) => Effect.fail(notSupported('link', fromPath)),
  makeDirectory,
  makeTempDirectory: () => Effect.fail(notSupported('makeTempDirectory', '')),
  makeTempDirectoryScoped: () => Effect.fail(notSupported('makeTempDirectoryScoped', '')),
  makeTempFile: () => Effect.fail(notSupported('makeTempFile', '')),
  makeTempFileScoped: () => Effect.fail(notSupported('makeTempFileScoped', '')),
  open: (path) => Effect.fail(notSupported('open', path)),
  readDirectory: (path) => Effect.fail(notSupported('readDirectory', path)),
  readFile,
  readLink: (path) => Effect.fail(notSupported('readLink', path)),
  realPath: (path) => Effect.fail(notSupported('realPath', path)),
  remove,
  rename: (oldPath) => Effect.fail(notSupported('rename', oldPath)),
  stat,
  symlink: (fromPath) => Effect.fail(notSupported('symlink', fromPath)),
  truncate: (path) => Effect.fail(notSupported('truncate', path)),
  utimes: (path) => Effect.fail(notSupported('utimes', path)),
  watch: (path) => Stream.fail(notSupported('watch', path)),
  writeFile,
})

/** `Layer` providing the Expo-backed `FileSystem.FileSystem`. */
const layer: Layer.Layer<FileSystem.FileSystem> = Layer.succeed(FileSystem.FileSystem, make)

export { make, layer }
