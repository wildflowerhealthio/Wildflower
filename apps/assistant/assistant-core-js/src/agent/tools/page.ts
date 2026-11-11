import { Array, Effect, Encoding, Option, Schema, String as Str } from 'effect'

import * as ChatPatient from '../../chat-patient.ts'
import { type FhirReadFailed, FhirRecords } from '../../fhir-records.ts'
import * as PatientPin from '../patient-pin.ts'
import type * as ChatTools from './chat-tools.ts'
import { refuse, ToolCallRefused } from './refusal.ts'
import { withinResultLimit } from './result-limit.ts'

/**
 * One page of search results, as `search_records` and `next_page` read it
 * and give it to the agent, with the cursor to the next.
 *
 * @packageDocumentation
 */

/**
 * `search_records`' and `next_page`'s result, as the JSON the agent reads:
 * one page of `resources`; `total` when the server counted the matches;
 * `more` when the server has another page, and the `next` cursor to it when
 * that page is under the FHIR base.
 */
const PageResult = Schema.parseJson(
  Schema.Struct({
    resources: Schema.Array(Schema.Unknown),
    total: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
    more: Schema.Boolean,
    next: Schema.optionalWith(Schema.String, { exact: true }),
  })
)

/** `url` as a path under `fhirBaseUrl` (relative, no leading slash), if it is one. */
const pathUnderBaseOf = ({
  url,
  fhirBaseUrl,
}: {
  readonly url: string
  readonly fhirBaseUrl: string
}): Option.Option<string> => {
  const base = URL.parse(`${fhirBaseUrl}/`)
  const target = base === null ? null : URL.parse(url, base)
  if (base === null || target === null || target.origin !== base.origin) return Option.none()
  // The base itself (`<base>?_getpages=…`, a server's paging handle) is under it too.
  if (`${target.pathname}/` === base.pathname) return Option.some(target.search)
  return target.pathname.startsWith(base.pathname)
    ? Option.some(`${target.pathname.slice(base.pathname.length)}${target.search}`)
    : Option.none()
}

/** A search result page, as far as the tools read it. */
const SearchBundle = Schema.Struct({
  resourceType: Schema.Literal('Bundle'),
  total: Schema.optional(Schema.NonNegativeInt),
  entry: Schema.optional(
    Schema.Array(Schema.Struct({ resource: Schema.optional(Schema.Unknown) }))
  ),
  link: Schema.optional(
    Schema.Array(Schema.Struct({ relation: Schema.String, url: Schema.String }))
  ),
})

/** Refuse `records` if any is about a patient other than the chat's. */
const refuseOtherPatientsRecords = (
  tools: ChatTools.Type,
  records: readonly unknown[]
): Effect.Effect<void, ToolCallRefused> =>
  Option.match(ChatPatient.patientIdIfOne(tools.patient), {
    onNone: () => Effect.void,
    onSome: (patientId) =>
      records.some((record) => PatientPin.isAboutAnotherPatient(record, patientId))
        ? refuse(
            "The server answered with records about another patient, so none are shown: this chat is about one patient. Search more narrowly, or don't include other records."
          )
        : Effect.void,
  })

/** The type a page path (`Observation?…`) searches; `None` for a server's paging handle (`?…`). */
const searchedTypeIfNamed = (path: string): Option.Option<string> =>
  Option.fromNullable(path.split(/[?/]/u)[0]).pipe(Option.filter(Str.isNonEmpty))

/** The opaque cursor for the page at `path`. */
const cursorOf = (path: string): string => Encoding.encodeBase64Url(path)

/** The page at `path` as the tool result's JSON. */
const readPage = (
  tools: ChatTools.Type,
  path: string
): Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> =>
  Effect.gen(function* () {
    const records = yield* FhirRecords
    const bundle = yield* records.read(path)
    const page = yield* Schema.decodeUnknown(SearchBundle)(bundle).pipe(
      Effect.mapError(
        () => new ToolCallRefused({ reason: "The server's answer wasn't a search result bundle." })
      )
    )
    const resources = Array.filterMap(page.entry ?? [], ({ resource }) =>
      Option.fromNullable(resource)
    )
    yield* refuseOtherPatientsRecords(tools, resources)
    const nextUrl = Array.findFirst(page.link ?? [], ({ relation }) => relation === 'next').pipe(
      Option.map(({ url }) => url)
    )
    const nextPath = Option.flatMap(nextUrl, (url) =>
      pathUnderBaseOf({ url, fhirBaseUrl: records.fhirBaseUrl })
    )
    return yield* withinResultLimit(
      Schema.encodeSync(PageResult)({
        resources,
        ...(page.total === undefined ? {} : { total: page.total }),
        more: Option.isSome(nextUrl),
        ...Option.match(nextPath, {
          onNone: () => ({}),
          onSome: (next) => ({ next: cursorOf(next) }),
        }),
      })
    )
  })

/** {@link PageResult}, read back from a kept result; `None` when it is not one. */
const decodePageResult = Schema.decodeUnknownOption(PageResult)

export { decodePageResult, PageResult, pathUnderBaseOf, readPage, searchedTypeIfNamed }
