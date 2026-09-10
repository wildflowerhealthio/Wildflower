import { Effect, ParseResult, Schema } from 'effect'
import { HttpArchive } from 'http-archive'

import { LOCAL_SOURCE, type PickedHar } from './picked-har.ts'

/**
 * Reading a file the user dropped or chose, and rejecting one that is not an
 * HTTP Archive *at the picker*, before it becomes the importer's problem.
 *
 * @remarks
 * A local file is validated the same way an extraction will read it — through
 * `web-trace-core`'s `HttpArchive.LogFromHarJson`, the one HTTP Archive parser
 * in the codebase — rather than a second, weaker check here. So a file the
 * picker accepts is a file the importer can parse, and a rejection carries the
 * reason back to the control the user just used instead of surfacing three
 * steps later. This module never *imports* the importer; the parser lives in
 * `web-trace-core`, below both.
 *
 * @packageDocumentation
 */

/** The one parse a picked file is gated on. */
const parseLog = Schema.decodeUnknown(HttpArchive.LogFromHarJson)

/**
 * The lead sentence shown when a dropped or chosen file is not a HAR.
 *
 * @remarks
 * Names the format in plain language — the distinction a user who picked the
 * wrong file can act on. {@link describeRejection} follows it with the parser's
 * own reason, so a file that *is* a HAR but trips one field (the case worth
 * debugging) says which field rather than stopping at "not the right kind of
 * file".
 */
const REJECTION_MESSAGE =
  "That file isn't a valid HAR recording. A HAR is the JSON a browser's network panel exports."

/**
 * Renders the parser's first complaint as a one-line `path — message`, the way
 * the rejection notice appends it.
 *
 * @remarks
 * `ArrayFormatter` over `TreeFormatter`: it yields the failing *leaves* with
 * their paths already split, so the first one is `log.entries.3.response.status`
 * rather than an indented tree the notice would have to flatten. An empty path
 * (invalid JSON fails at the root) renders as the bare message. Returns `''`
 * when the error carries no issue, so {@link describeRejection} can fall back to
 * the lead sentence alone.
 */
const parseDetail = (error: ParseResult.ParseError): string => {
  const [first] = ParseResult.ArrayFormatter.formatErrorSync(error)
  if (first === undefined) return ''
  const path = first.path.map(String).join('.')
  return path === '' ? first.message : `${path} — ${first.message}`
}

/**
 * The full rejection notice: the lead sentence, and the parser's own reason
 * under a `Details:` line when it has one.
 *
 * @remarks
 * The detail is the raw parser path and message, not a rewrite of it — enough
 * to point at the field a foreign export (a Firefox recording, say) wrote in a
 * shape this reader does not accept. It is exposed on purpose; the lead sentence
 * stays first so a user who simply picked the wrong file still reads plain
 * language before the schema path.
 */
const describeRejection = (error: ParseResult.ParseError): string => {
  const detail = parseDetail(error)
  return detail === '' ? REJECTION_MESSAGE : `${REJECTION_MESSAGE}\n\nDetails: ${detail}`
}

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
 * Validation goes through `HttpArchive.LogFromHarJson`, so a file that is not
 * JSON and a file that is JSON but not an HTTP Archive both fail here rather
 * than downstream; the parse result itself is discarded, because the picker
 * hands on the *text* and the extraction parses it again when it runs. This is
 * a gate, not the parse. A lazy `Effect` on purpose: nothing runs until the
 * caller runs it, where the pick's side effects belong.
 */
const acceptLocalHar = (file: ReadableFile): Effect.Effect<PickedHar, string> =>
  Effect.promise(() => file.text()).pipe(
    Effect.flatMap((text) =>
      parseLog(text).pipe(
        Effect.as<PickedHar>({ fileName: file.name, text, source: LOCAL_SOURCE }),
        Effect.mapError(describeRejection)
      )
    )
  )

export { acceptLocalHar, describeRejection, type ReadableFile, REJECTION_MESSAGE }
