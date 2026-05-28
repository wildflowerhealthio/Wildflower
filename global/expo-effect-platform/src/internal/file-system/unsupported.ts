import { type Error as PlatformError } from '@effect/platform'
import { Effect, Stream } from 'effect'
import { systemError } from './helpers.ts'

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
 * The set of `FileSystem.FileSystem` methods that have no equivalent in
 * `expo-file-system`. Each fails with a typed `SystemError` (`reason:
 * 'BadResource'`); `watch` returns a `Stream` whose failure is structurally
 * separate from the `Effect.fail` path.
 *
 * Transitively unsupported: `stream` and `sink` are synthesised by
 * `FileSystem.make` from `open` (which always fails here) — so
 * `fs.stream(path)` and `fs.sink(path)` surface as "open is not supported"
 * rather than "stream/sink is not supported."
 */
const unsupportedMethods = {
  chmod: (path: string) => Effect.fail(notSupported('chmod', path)),
  chown: (path: string) => Effect.fail(notSupported('chown', path)),
  copy: (fromPath: string) => Effect.fail(notSupported('copy', fromPath)),
  copyFile: (fromPath: string) => Effect.fail(notSupported('copyFile', fromPath)),
  link: (fromPath: string) => Effect.fail(notSupported('link', fromPath)),
  makeTempDirectory: () => Effect.fail(notSupported('makeTempDirectory', '')),
  makeTempDirectoryScoped: () => Effect.fail(notSupported('makeTempDirectoryScoped', '')),
  makeTempFile: () => Effect.fail(notSupported('makeTempFile', '')),
  makeTempFileScoped: () => Effect.fail(notSupported('makeTempFileScoped', '')),
  open: (path: string) => Effect.fail(notSupported('open', path)),
  readDirectory: (path: string) => Effect.fail(notSupported('readDirectory', path)),
  readLink: (path: string) => Effect.fail(notSupported('readLink', path)),
  realPath: (path: string) => Effect.fail(notSupported('realPath', path)),
  rename: (oldPath: string) => Effect.fail(notSupported('rename', oldPath)),
  symlink: (fromPath: string) => Effect.fail(notSupported('symlink', fromPath)),
  truncate: (path: string) => Effect.fail(notSupported('truncate', path)),
  utimes: (path: string) => Effect.fail(notSupported('utimes', path)),
  watch: (path: string) => Stream.fail(notSupported('watch', path)),
}

export { notSupported, unsupportedMethods }
