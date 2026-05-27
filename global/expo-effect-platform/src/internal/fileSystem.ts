import * as PlatformError from '@effect/platform/Error'
import * as FileSystem from '@effect/platform/FileSystem'
import * as Context from 'effect/Context'
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
 * Stringify an arbitrary thrown value into a single line suitable for the
 * `SystemError.description` field. Always renders the cause so traces don't
 * collapse to identical generic strings — `Paths.info`'s default `Unknown`
 * reason then carries enough context to diagnose.
 */
const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (cause === null) return 'null'
  if (cause === undefined) return 'undefined'
  if (typeof cause === 'string') return cause
  try {
    return JSON.stringify(cause)
  } catch {
    return 'unrepresentable cause'
  }
}

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
    description: description ?? `expo-file-system threw: ${describeCause(cause)}`,
    pathOrDescriptor: path,
    cause,
  })

/**
 * Tag unimplemented operations with `reason: 'BadResource'` (the closest typed
 * reason to ENOSYS / EOPNOTSUPP). `PermissionDenied` is reserved for
 * authorization failures the caller could retry under a different mode/ACL —
 * an unsupported operation is structurally different. Description carries the
 * package-level "not supported" message so callers can branch on either.
 */
const notSupported = (method: string, path: string): PlatformError.SystemError =>
  systemError(
    method,
    path,
    'BadResource',
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
 * Probe an arbitrary path for existence + kind via `Paths.info`. A missing
 * path returns `{ exists: false, isDirectory: null }` rather than throwing,
 * so the only thing that can land in the `Unknown` catch is a programmer-
 * error misuse — the description widening in {@link systemError} preserves
 * the underlying message for diagnosis.
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

const makeDirectory: FileSystem.FileSystem['makeDirectory'] = (path, options) => {
  const recursive = options?.recursive ?? false
  // Non-recursive `mkdir` on Node's adapter surfaces `EEXIST` as
  // `reason: 'AlreadyExists'`. expo-file-system's `Directory.create()` throws
  // an opaque message in this case which `trySystem` would map to `Unknown`,
  // diverging from the Node contract. Pre-check via `Paths.info` and fail
  // with the matching reason so cross-platform callers pattern-matching on
  // `e.reason === 'AlreadyExists'` behave consistently.
  if (!recursive) {
    return Effect.flatMap(inspect('makeDirectory', path), (info) => {
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
  }
  return trySystem('makeDirectory', path, 'Unknown', () => {
    // `recursive: true` on the Effect surface maps to BOTH `intermediates`
    // (creates parents) AND `idempotent` (no-op if already exists), matching
    // Node's `fs.mkdir(..., { recursive: true })` semantics. expo-file-system
    // separates the two flags but the Effect contract treats them as one.
    new Directory(fileUri(path)).create({ intermediates: true, idempotent: true })
  })
}

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

const writeFile: FileSystem.FileSystem['writeFile'] = (path, data, options) => {
  // `WriteFileOptions.flag` and `mode` are not honoured by `File.write`. A
  // caller asking for `'a'` (append) or `'wx'` (exclusive) would otherwise
  // silently get a clobbering truncate; fail loudly so the contract break
  // surfaces in the typed channel.
  if (options?.flag !== undefined && options.flag !== 'w') {
    return Effect.fail(
      systemError(
        'writeFile',
        path,
        'BadResource',
        new Error(`WriteFileOptions.flag=${options.flag} is not supported by expo-file-system`),
        `WriteFileOptions.flag=${options.flag} is not supported by expo-file-system`
      )
    )
  }
  return trySystem('writeFile', path, 'Unknown', () => {
    // `FileCreateOptions.overwrite: true` collapses the create-or-overwrite
    // path into a single native call, avoiding the TOCTOU window of a
    // delete-then-create dance.
    const file = new File(fileUri(path))
    file.create({ overwrite: true })
    file.write(data)
  })
}

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
 * Implemented: `access`, `exists` (derived), `stat`, `makeDirectory`,
 * `remove`, `readFile`, `readFileString` (derived), `writeFile`,
 * `writeFileString` (derived).
 *
 * Directly unsupported (fail with `reason: 'BadResource'`): `chmod`, `chown`,
 * `copy`, `copyFile`, `link`, `makeTempDirectory`, `makeTempDirectoryScoped`,
 * `makeTempFile`, `makeTempFileScoped`, `open`, `readDirectory`, `readLink`,
 * `realPath`, `rename`, `symlink`, `truncate`, `utimes`, `watch`.
 *
 * Transitively unsupported: `stream` and `sink` are synthesised by
 * `FileSystem.make` from `open` (which always fails) — so `fs.stream(path)`
 * and `fs.sink(path)` surface as "open is not supported" rather than
 * "stream/sink is not supported."
 *
 * `WriteFileOptions.flag` and `mode` are not honoured (expo-file-system's
 * `File.write` has no equivalent surface): a non-default `flag` fails with
 * `reason: 'BadResource'` rather than silently clobbering; `mode` is dropped.
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

// ---------------------------------------------------------------------------
// ExpoCacheDir
// ---------------------------------------------------------------------------

/**
 * Absolute path (no `file://` scheme) to Expo's cache directory. Cache
 * contents may be evicted by the OS under storage pressure — appropriate for
 * artefacts that can always be regenerated on boot.
 *
 * @remarks
 * `@effect/platform` does not define a shared `CacheDir`-style tag, so this
 * tag's identity is package-local. Cross-platform code that wants a single
 * "cache directory" service to consume would need a tag defined in a shared
 * package both platforms can import.
 */
class ExpoCacheDir extends Context.Tag('expo-effect-platform/ExpoCacheDir')<
  ExpoCacheDir,
  string
>() {}

/**
 * `Layer` providing {@link ExpoCacheDir}.
 *
 * `Layer.sync` defers the `Paths.cache.uri` getter access to layer-build
 * time, so the resolved value reflects whatever mock state is active when
 * the layer is materialised (relevant under Jest where the getter may be
 * stubbed per-test).
 */
const expoCacheDirLayer: Layer.Layer<ExpoCacheDir> = Layer.sync(ExpoCacheDir, () =>
  Paths.cache.uri.replace(/^file:\/\//, '')
)

export { make, layer, ExpoCacheDir, expoCacheDirLayer }
