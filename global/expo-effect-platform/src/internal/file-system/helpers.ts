import { Error as PlatformError } from '@effect/platform'
import { Effect } from 'effect'
import { Paths } from 'expo-file-system'
import * as Telemetry from '../../telemetry.ts'

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
  trySystem(method, path, 'Unknown', () => Paths.info(fileUri(path))).pipe(
    Effect.withSpan(Telemetry.FileSystem.Inspect.Span.Name, {
      attributes: { [Telemetry.FileSystem.Attributes.Path]: path },
    })
  )

/**
 * `SystemError` reasons that are normal control flow a caller branches on
 * (`exists` → `false`, `mkdir` racing an extant dir) rather than operational
 * faults. Logged at `Debug` so the hot `exists` path stays quiet while genuine
 * faults (`Unknown` / `PermissionDenied` / `BadResource`) surface at `Warning`.
 */
const expectedReasons: ReadonlySet<PlatformError.SystemErrorReason> =
  new Set<PlatformError.SystemErrorReason>(['NotFound', 'AlreadyExists'])

/**
 * Pipeable wrapper that gives a `FileSystem` op its OTel span and one-shot
 * failure logging. On failure it records the `error.type` (the
 * `SystemError.reason`) on the op span and logs once — at the severity
 * {@link expectedReasons} selects — so a native failure can never pass
 * silently while routine existence probes don't spam the on-device log. The
 * span's `expo_fs.path` attribute carries the target path.
 *
 * Defects (a thrown value that escaped {@link trySystem}) are deliberately
 * left to propagate untouched: every reachable op failure is already a typed
 * `SystemError`, so a defect here is a programmer error that should crash the
 * fiber loudly rather than be folded into the same log line.
 *
 * @example
 * ```ts
 * Effect.flatMap(inspect('stat', path), …).pipe(instrument('stat', Span.Name, path))
 * ```
 */
const instrument =
  (method: string, spanName: string, path: string) =>
  <A>(
    effect: Effect.Effect<A, PlatformError.SystemError>
  ): Effect.Effect<A, PlatformError.SystemError> =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan(Telemetry.FileSystem.Attributes.ErrorType, error.reason).pipe(
          Effect.zipRight(
            (expectedReasons.has(error.reason) ? Effect.logDebug : Effect.logWarning)(
              `ExpoFileSystem.${method} failed: ${error.reason} (${path})`,
              error
            )
          )
        )
      ),
      Effect.withSpan(spanName, {
        attributes: { [Telemetry.FileSystem.Attributes.Path]: path },
      })
    )

export { fileUri, describeCause, systemError, trySystem, inspect, instrument }
