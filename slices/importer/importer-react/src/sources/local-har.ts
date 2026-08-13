import { Effect } from 'effect'
import { fromHarJson } from 'web-trace-core/har'

import { LOCAL_SOURCE, type PickedHar } from './picked-har.ts'

/**
 * Reading a file the user dropped or chose, and rejecting one that is not a HAR
 * *at the picker*, before it becomes the importer's problem.
 *
 * @remarks
 * A local file is validated the same way a replay will read it — through
 * `web-trace-core`'s `fromHarJson`, the one HAR parser in the codebase — rather
 * than a second, weaker check here. So a file the picker accepts is a file the
 * importer can parse, and a rejection carries the reason back to the control the
 * user just used instead of surfacing three steps later. This module never
 * *imports* the importer; the parser lives in `web-trace-core`, below both.
 *
 * @packageDocumentation
 */

/**
 * The message shown when a dropped or chosen file is not a HAR.
 *
 * @remarks
 * Names the format rather than echoing the parser's `ParseError`, whose text is
 * a schema path a user cannot act on. The distinction the user can act on is
 * "this is not the right kind of file", so that is what it says.
 */
const REJECTION_MESSAGE =
  "That file isn't a valid HAR recording. A HAR is the JSON a browser's network panel exports."

/**
 * The minimal surface {@link acceptLocalHar} reads off a file.
 *
 * @remarks
 * Structural rather than the DOM `File` type: the function needs only a name and
 * the file's text, and stating that keeps it testable without constructing a
 * `File` or a `DataTransfer`. A real `File` satisfies it.
 */
interface ReadableFile {
  /** The file's name, carried onto the {@link PickedHar}. */
  readonly name: string
  /** The file's contents as text, the way `File.text()` reads them. */
  text(): Promise<string>
}

/**
 * Reads a local file and validates it as a HAR, before it is offered as a pick.
 *
 * @param file - The dropped or chosen file
 * @returns A lazy `Effect` that yields the accepted {@link PickedHar} carrying a
 *   `local` source, or fails with the reason the file was rejected
 *
 * @remarks
 * An `Effect` rather than an already-run `Promise`: the validation is a parse
 * that either yields a value or names why it did not — exactly the success/error
 * channels an `Effect` carries — so the pipeline reads as one (`fromHarJson`
 * succeeds into the pick, its `ParseError` maps to {@link REJECTION_MESSAGE}) and
 * nothing runs until the caller runs it, where the pick's side effects belong.
 * Validation goes through `fromHarJson`, so a file that is not JSON and a file
 * that is JSON but not a HAR both fail here rather than downstream; the parse
 * result itself is discarded, because the picker hands on the *text* and the
 * replay parses it again when it runs. This is a gate, not the parse.
 */
const acceptLocalHar = (file: ReadableFile): Effect.Effect<PickedHar, string> =>
  Effect.promise(() => file.text()).pipe(
    Effect.flatMap((text) =>
      fromHarJson(text).pipe(
        Effect.as<PickedHar>({ fileName: file.name, text, source: LOCAL_SOURCE }),
        Effect.mapError(() => REJECTION_MESSAGE)
      )
    )
  )

export { acceptLocalHar, type ReadableFile, REJECTION_MESSAGE }
