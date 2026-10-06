import { Context, Data, Effect, Schema } from 'effect'

/**
 * The base's one way to call the Tauri host: a command name and its
 * camelCase arguments in, the command's JSON answer out.
 *
 * @remarks
 * The app provides `invoke` from `@tauri-apps/api/core`; tests a fake. The
 * answer is `unknown` here and decoded by each command's schema, so nothing
 * the host sends is trusted by its static type.
 */
class TauriInvoke extends Context.Tag('servers-core/TauriInvoke')<
  TauriInvoke,
  (command: string, args?: Readonly<Record<string, unknown>>) => Promise<unknown>
>() {}

/** The host refused or failed `command`: Tauri rejected the invoke with `cause`. */
class HostCommandFailed extends Data.TaggedError('HostCommandFailed')<{
  readonly command: string
  readonly cause: unknown
}> {
  // Data.TaggedError leaves `.message` empty by default; name the command so a
  // logged failure says which call it was.
  override get message(): string {
    return `the host command ${this.command} failed: ${String(this.cause)}`
  }
}

/** The host answered `command` with a value its schema doesn't decode. */
class HostAnswerUndecodable extends Data.TaggedError('HostAnswerUndecodable')<{
  readonly command: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `the host's answer to ${this.command} didn't decode: ${String(this.cause)}`
  }
}

/** Either way a host command can fail. */
type HostCommandError = HostCommandFailed | HostAnswerUndecodable

/**
 * Invoke `command` on the host and decode its answer with `answer`.
 *
 * @param command - The Tauri command, e.g. `plugin:app|version`.
 * @param answer - The schema the command's JSON answer decodes with.
 * @param args - The command's arguments, under their camelCase names.
 */
const invokeHostCommand = <A, I>(
  command: string,
  answer: Schema.Schema<A, I>,
  args?: Readonly<Record<string, unknown>>
): Effect.Effect<A, HostCommandError, TauriInvoke> =>
  Effect.flatMap(TauriInvoke, (invoke) =>
    Effect.tryPromise({
      try: () => invoke(command, args),
      catch: (cause) => new HostCommandFailed({ command, cause }),
    })
  ).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknown(answer)(json).pipe(
        Effect.mapError((cause) => new HostAnswerUndecodable({ command, cause }))
      )
    )
  )

export { HostAnswerUndecodable, HostCommandFailed, invokeHostCommand, TauriInvoke }
export type { HostCommandError }
