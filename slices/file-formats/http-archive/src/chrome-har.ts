import { type Effect, type ParseResult, Schema } from 'effect'

import type { HarToJsonOptions } from './emit.ts'
import { HarEntry, HarLog } from './har.ts'

/**
 * HAR 1.2 as Chrome DevTools writes it: {@link Har} plus the `_`-prefixed
 * vendor extras a "Save all as HAR" export puts on each entry.
 *
 * @remarks
 * The base schemas ignore unknown keys, so decoding a DevTools export through
 * {@link Har} drops `_initiator`, `_priority` and `_resourceType`, and
 * encoding one through it never writes them. These schemas are the same
 * structure with those fields declared, so a Chrome archive reads and writes
 * with them intact. They are kept off the base schemas because they are one
 * browser's extension, not the format.
 *
 * A {@link ChromeHar} is structurally a {@link Har}, so anything that reads an
 * archive takes one as it stands. Writing one goes through
 * {@link chromeHarToJson}: {@link harToJson} would encode it as a plain `Har`
 * and drop the extras.
 *
 * @packageDocumentation
 */

/**
 * Chrome's `_initiator` — what caused the request, e.g. `{ type: 'parser' }`
 * for a navigation or `{ type: 'script', stack: … }` for a script's fetch.
 *
 * @remarks
 * Only `type` is typed. The rest (`url`, `lineNumber`, a call `stack`) is
 * DevTools' own debugging detail, kept verbatim rather than modelled, so a
 * round trip does not lose it.
 */
const ChromeHarInitiator = Schema.Struct(
  { type: Schema.String },
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)

/** A HAR `entry` with the DevTools extras. */
const ChromeHarEntry = Schema.Struct({
  ...HarEntry.fields,
  _initiator: Schema.optional(ChromeHarInitiator),
  /** The fetch priority DevTools reports, e.g. `VeryHigh`, `High`, `Low`. */
  _priority: Schema.optional(Schema.String),
  /** What DevTools classes the resource as, e.g. `document`, `xhr`, `fetch`, `image`. */
  _resourceType: Schema.optional(Schema.String),
})

/** A HAR `log` whose entries carry the DevTools extras. */
const ChromeHarLog = Schema.Struct({
  ...HarLog.fields,
  entries: Schema.Array(ChromeHarEntry),
})

/** A complete HAR archive as DevTools writes it. */
const ChromeHar = Schema.Struct({ log: ChromeHarLog }).annotations({
  identifier: 'ChromeHar',
  description: 'A HAR 1.2 archive with the Chrome DevTools entry extras.',
})

/** A DevTools archive as the text of a `.har` file. */
const ChromeHarFromJson = Schema.parseJson(ChromeHar).annotations({
  identifier: 'ChromeHarFromJson',
  description:
    'A HAR 1.2 archive with the Chrome DevTools entry extras, as the text of a .har file.',
})

/** {@link ChromeHarFromJson}, writing two-space-indented JSON. */
const ChromeHarFromPrettyJson = Schema.parseJson(ChromeHar, { space: 2 })

/**
 * Serializes a DevTools archive to the text of a `.har` file, extras included.
 *
 * @param har - The archive to write
 * @param options - Whether to indent the JSON, as DevTools does
 * @returns The file text, or a `ParseError` when `har` does not encode
 */
const chromeHarToJson = (
  har: ChromeHar,
  options: HarToJsonOptions = {}
): Effect.Effect<string, ParseResult.ParseError> =>
  Schema.encode(options.pretty === true ? ChromeHarFromPrettyJson : ChromeHarFromJson)(har)

/** Reads the text of a `.har` file into a DevTools archive, extras included. */
const chromeHarFromJson = Schema.decodeUnknown(ChromeHarFromJson)

type ChromeHar = typeof ChromeHar.Type
type ChromeHarEntry = typeof ChromeHarEntry.Type
type ChromeHarInitiator = typeof ChromeHarInitiator.Type
type ChromeHarLog = typeof ChromeHarLog.Type

export {
  ChromeHar,
  ChromeHarEntry,
  ChromeHarFromJson,
  ChromeHarInitiator,
  ChromeHarLog,
  chromeHarFromJson,
  chromeHarToJson,
}
