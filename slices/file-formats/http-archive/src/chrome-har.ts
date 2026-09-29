import { type DateTime, type Effect, type ParseResult, Schema } from 'effect'

import type { HarToJsonOptions } from './emit.ts'
import { type HarCreator, HarEntry, HarLog, type HarPage } from './har.ts'

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
 * Alongside the schemas is the vocabulary a producer of a DevTools-shaped
 * archive writes with: the {@link CHROME_CREATOR}, the extras' literal values
 * ({@link ChromeResourceType}, {@link ChromePriority},
 * {@link ChromeInitiatorType}) and {@link chromeExtrasOf} pairing them, and
 * {@link chromePageOf} / {@link chromeHarOf} for pages and the archive. The
 * schemas stay open strings, so an export carrying a value not listed here
 * still reads.
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

/**
 * The `creator` a DevTools "Save all as HAR" export writes: `WebInspector`,
 * versioned as the WebKit build Chrome reports itself as.
 */
const CHROME_CREATOR: HarCreator = { name: 'WebInspector', version: '537.36' }

/**
 * The `_resourceType`s a producer writes: a navigation (`document`), an
 * `XMLHttpRequest` (`xhr`) or a `fetch()` call (`fetch`).
 *
 * @remarks
 * DevTools has more (`image`, `script`, `stylesheet`, …), which
 * {@link ChromeHarEntry} reads as the open string it declares.
 */
type ChromeResourceType = 'document' | 'xhr' | 'fetch'

/** The `_priority` levels DevTools reports, highest first. */
type ChromePriority = 'VeryHigh' | 'High' | 'Medium' | 'Low' | 'VeryLow'

/**
 * The `_initiator.type`s a producer writes: the browser itself (`other`, as for
 * a navigation), the HTML parser (`parser`) or a script (`script`).
 */
type ChromeInitiatorType = 'other' | 'parser' | 'script'

/** The DevTools extras of one entry, narrowed to the values a producer writes. */
type ChromeHarExtras = {
  readonly _initiator: { readonly type: ChromeInitiatorType }
  readonly _priority: ChromePriority
  readonly _resourceType: ChromeResourceType
}

/** The `_initiator` type and `_priority` DevTools records for each resource type. */
const EXTRAS_BY_RESOURCE_TYPE: Readonly<
  Record<
    ChromeResourceType,
    { readonly initiator: ChromeInitiatorType; readonly priority: ChromePriority }
  >
> = {
  document: { initiator: 'other', priority: 'VeryHigh' },
  xhr: { initiator: 'script', priority: 'High' },
  fetch: { initiator: 'script', priority: 'High' },
}

/**
 * The DevTools extras an entry of `resourceType` carries.
 *
 * @param resourceType - What the browser fetched
 * @returns `_initiator`, `_priority` and `_resourceType` as DevTools records
 *   them: a navigation is initiated by the browser at `VeryHigh`, a script's
 *   `xhr` or `fetch` by the script at `High`
 */
const chromeExtrasOf = (resourceType: ChromeResourceType): ChromeHarExtras => {
  const { initiator, priority } = EXTRAS_BY_RESOURCE_TYPE[resourceType]
  return { _initiator: { type: initiator }, _priority: priority, _resourceType: resourceType }
}

/** The navigation {@link chromePageOf} writes. */
interface ChromePageSpec {
  readonly id: string
  /** The page's URL, which DevTools also uses as its title. */
  readonly url: string
  readonly startedAt: DateTime.Utc
  /** Milliseconds from `startedAt` to `DOMContentLoaded`. */
  readonly onContentLoadMillis: number
  /** Milliseconds from `startedAt` to `load`. */
  readonly onLoadMillis: number
}

/** A HAR page as DevTools writes one: titled with its URL. */
const chromePageOf = (spec: ChromePageSpec): HarPage => ({
  startedDateTime: spec.startedAt,
  id: spec.id,
  title: spec.url,
  pageTimings: { onContentLoad: spec.onContentLoadMillis, onLoad: spec.onLoadMillis },
})

/** A HAR 1.2 archive of `pages` and `entries` under the {@link CHROME_CREATOR}. */
const chromeHarOf = (pages: readonly HarPage[], entries: readonly ChromeHarEntry[]): ChromeHar => ({
  log: { version: '1.2', creator: CHROME_CREATOR, pages, entries },
})

type ChromeHar = typeof ChromeHar.Type
type ChromeHarEntry = typeof ChromeHarEntry.Type
type ChromeHarInitiator = typeof ChromeHarInitiator.Type
type ChromeHarLog = typeof ChromeHarLog.Type

export {
  CHROME_CREATOR,
  ChromeHar,
  ChromeHarEntry,
  ChromeHarFromJson,
  ChromeHarInitiator,
  ChromeHarLog,
  chromeExtrasOf,
  chromeHarFromJson,
  chromeHarOf,
  chromeHarToJson,
  chromePageOf,
}
export type {
  ChromeHarExtras,
  ChromeInitiatorType,
  ChromePageSpec,
  ChromePriority,
  ChromeResourceType,
}
