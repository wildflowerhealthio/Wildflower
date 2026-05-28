import { Error as PlatformError } from '@effect/platform'
import { Effect } from 'effect'
import { Paths } from 'expo-file-system'

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

export { fileUri, describeCause, systemError, trySystem, inspect }
