import { Data, Effect, Schema } from 'effect'

/**
 * The recordings folder, as the host reports it: where `SaveHar` writes, and
 * whether the platform can reveal a saved file in its file manager.
 *
 * @packageDocumentation
 */

/**
 * How the page calls a host command: Tauri's `invoke`, narrowed to the
 * arguments the recorder passes, a command name and its named arguments.
 */
type InvokeHostCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/** The host command that answers with the {@link SaveFolder}. */
const SAVE_FOLDER_COMMAND = 'recorder_save_folder'

/**
 * `recorder_save_folder`'s answer.
 *
 * @remarks
 * Wire: `{"path":"/…/Wildflower Recordings","revealsFiles":true}`, pinned by
 * `recorder-wire-golden.json`, which `recorder-rust`'s `SaveFolder` reads
 * too.
 */
const SaveFolder = Schema.Struct({
  /** The folder's absolute path. */
  path: Schema.NonEmptyString,
  /** Whether the page can offer Show file: only a desktop file manager reveals one. */
  revealsFiles: Schema.Boolean,
})
type SaveFolder = typeof SaveFolder.Type

/** The host couldn't say where recordings go, and `message` says why. */
class SaveFolderUnreadable extends Data.TaggedError('SaveFolderUnreadable')<{
  readonly message: string
}> {}

/** An `Error`'s message, or the value itself as text. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Read the recordings folder from the host.
 *
 * @param invoke - Tauri's `invoke`
 * @returns The {@link SaveFolder}, or {@link SaveFolderUnreadable} with the
 *   host's reason when it has none, or when its answer doesn't decode
 */
const readSaveFolder = (
  invoke: InvokeHostCommand
): Effect.Effect<SaveFolder, SaveFolderUnreadable> =>
  Effect.tryPromise({
    try: () => invoke(SAVE_FOLDER_COMMAND),
    catch: (error) => new SaveFolderUnreadable({ message: messageOf(error) }),
  }).pipe(
    Effect.flatMap((answer) =>
      Schema.decodeUnknown(SaveFolder)(answer).pipe(
        Effect.mapError((error) => new SaveFolderUnreadable({ message: messageOf(error) }))
      )
    )
  )

export { messageOf, readSaveFolder, SAVE_FOLDER_COMMAND, SaveFolder, SaveFolderUnreadable }
export type { InvokeHostCommand }
