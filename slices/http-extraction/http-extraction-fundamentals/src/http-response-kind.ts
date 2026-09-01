import type { Effect, Option, ParseResult } from 'effect'
import { deepFreeze } from 'kitchen-sink'
import type { HttpResponse } from './http-response.ts'

/**
 * What a {@link HttpResponseKind.tryRecognize} match tells a router: how
 * specific the claim is, and (optionally) the identity this response's
 * resources key under.
 */
interface RecognizedUrlData {
  /** The number routing ranks by, highest wins — see the `Specificity` tiers. */
  readonly specificity: number
  /**
   * The namespace this response's resources key under; absent = recognized but
   * mints no identity (a recorder records, it doesn't import). Structurally
   * `fhir-r4/identity`'s `SourceIdentity`, on purpose — the layering seam stays
   * clean without this package naming FHIR.
   */
  readonly source?: { readonly system: string; readonly baseUrl?: string }
}

/**
 * Stateless, struct-shaped *definition* of an entity — not an entity
 * in and of itself, just a recipe a routing loop uses to recognize
 * matching responses and decode them. A concrete entity
 * (e.g. `PatientResponseKind`) is a value built by {@link make}, not an
 * instance; its `parse` closes over whatever schemas / decoders it
 * needs and takes the {@link HttpResponse} each call. Passing
 * the full response (not a pre-extracted slice of fields) keeps the
 * data flow visible: an entity can read `response.text()`,
 * `response.headers`, and `response.url` on demand without the
 * dispatcher having to know in advance which it'll need.
 *
 * Import callers use the file as a namespace:
 * `import { HttpResponseKind } from 'http-extraction-fundamentals'`
 * → `HttpResponseKind.HttpResponseKind<T>` for the type,
 * `HttpResponseKind.make({...})` for the constructor.
 *
 * - `name`: stable identifier, useful for logging and reporting which
 *   entity claimed a response.
 * - `tryRecognize`: URL-match; `Some` a {@link RecognizedUrlData} when this
 *   entity claims the URL (carrying how specific the claim is and the identity
 *   its resources key under), `None` when it does not. Whichever loop walks the
 *   entity list — `Extraction.run`/`routeTo` over an archive, or a live handler
 *   over sniffed traffic — consults this to route each response, **highest
 *   specificity wins** (ties → list order).
 * - `parse`: `Effect`-returning decode from {@link HttpResponse}
 *   to the resource array, with `ParseError` in the error channel.
 *   Returning an `Effect` (rather than an `Either`) lets entities log
 *   progress (`Effect.logInfo` for dropped bundle entries, for
 *   example) and stays compatible with future requirements that may
 *   need Effect-typed dependencies (clock, randomness, …). `parse`
 *   stays a *pure decode*: it never emits navigation.
 */
interface HttpResponseKind<out TParsed> {
  readonly name: string
  readonly tryRecognize: (url: string) => Option.Option<RecognizedUrlData>
  readonly parse: (
    response: HttpResponse
  ) => Effect.Effect<readonly TParsed[], ParseResult.ParseError>
}

/**
 * Shallow-clone + deep-freeze the supplied definition so callers
 * cannot mutate an entity list after construction — a routing loop
 * pins the matched entity per response and assumes it stays put. The
 * clone copies the known fields (`name`, `tryRecognize`, `parse`) so an
 * extra unexpected property on the caller's object is silently
 * dropped.
 */
const make = <TParsed>(definition: HttpResponseKind<TParsed>): HttpResponseKind<TParsed> =>
  deepFreeze({
    name: definition.name,
    tryRecognize: definition.tryRecognize,
    parse: definition.parse,
  })

export { make }
export type { HttpResponseKind, RecognizedUrlData }
