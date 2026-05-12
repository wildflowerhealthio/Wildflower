import type { Either, ParseResult } from 'effect'
import { MutableHashMap, Option } from 'effect'
import type { ReadonlyRecord } from 'effect/Record'
import type * as Entity from './entity.ts'
import { RemoteResponse } from './response.ts'
import type * as WebViewSource from './web-view-source.ts'

/**
 * A `Remote` is a configured external data source. The shape is
 * stateless from the caller's perspective: the dispatch methods
 * (`shouldKeepResponse` / `handleResponseData` / `handleResponseFinished`)
 * are bound closures that share a private `MutableHashMap` of
 * in-progress responses created in {@link make}. No inheritance, no
 * `this` — each concrete remote (e.g. `FhirR4Remote`) is the result
 * of one `Remote.make({...})` call.
 *
 * Import callers use the file as a namespace:
 * `import * as Remote from 'collector-core/remote'`.
 *
 * - `firstPage`: where to start the sync. A {@link WebViewSource.Uri}
 *   points at a remote page; a {@link WebViewSource.Html} is an
 *   inline bootstrap page.
 * - `name`: stable identifier for logs / UI.
 * - `shouldKeepResponse`: called on `ResponseStart`. Returns `true`
 *   when some entity matches the response URL — in that case the
 *   remote registers the in-flight response so subsequent
 *   `ResponseData` chunks accrue.
 * - `handleResponseData`: appends a chunk to a tracked response.
 * - `handleResponseFinished`: assembles the body, picks the matching
 *   entity, runs `entity.parse(init)`, and surfaces both the raw
 *   {@link Entity.Init} and the `Either<Parsed, ParseError>` result
 *   through the caller's `onResult` callback. Unmatched URLs are a
 *   silent no-op (they were filtered by `shouldKeepResponse` first).
 */
/**
 * Public surface of a built remote. The resource union is hidden
 * behind {@link Config}'s `onResult` — once `make` returns, the
 * dispatch methods only deal with wire shapes (string ids, byte
 * chunks), so {@link Remote} is non-generic.
 */
interface Remote {
  readonly firstPage: WebViewSource.Any
  readonly name: string
  readonly shouldKeepResponse: (event: {
    readonly id: string
    readonly url: string
    readonly status: number
    readonly statusText: string
    readonly headers: ReadonlyRecord<string, string>
  }) => boolean
  readonly handleResponseData: (event: { readonly id: string; readonly data: Uint8Array }) => void
  readonly handleResponseFinished: (event: { readonly id: string }) => void
}

interface Config<TResources> {
  readonly firstPage: WebViewSource.Any
  readonly name: string
  readonly entities: readonly Entity.Entity<TResources>[]
  /**
   * Fired once per matched, completed response. Carries both the raw
   * {@link Entity.Init} (so callers can audit-log the body
   * unconditionally) and the parse result (so they can route resources
   * on `Right` and log errors on `Left`).
   */
  readonly onResult: (args: {
    readonly init: Entity.Init
    readonly result: Either.Either<Entity.Parsed<TResources>, ParseResult.ParseError>
  }) => void
}

const make = <TResources>(config: Config<TResources>): Remote => {
  const inProgressResponses = MutableHashMap.empty<string, RemoteResponse>()

  const shouldKeepResponse: Remote['shouldKeepResponse'] = (event) => {
    if (!config.entities.some((e) => e.isFoundAt(event.url))) return false
    MutableHashMap.set(
      event.id,
      new RemoteResponse(event.url, event.status, event.statusText, event.headers)
    )(inProgressResponses)
    return true
  }

  const handleResponseData: Remote['handleResponseData'] = (event) => {
    const maybeResponse = MutableHashMap.get(event.id)(inProgressResponses)
    if (Option.isNone(maybeResponse)) {
      throw new Error('Received response data for response that is not being tracked')
    }
    maybeResponse.value.appendChunk(event.data)
  }

  const handleResponseFinished: Remote['handleResponseFinished'] = (event) => {
    const response = Option.getOrThrow(MutableHashMap.get(event.id)(inProgressResponses))
    MutableHashMap.remove(inProgressResponses, event.id)

    const entity = config.entities.find((e) => e.isFoundAt(response.url))
    if (entity === undefined) return

    const init: Entity.Init = {
      body: response.text(),
      contentType: response.headers['content-type'] ?? '',
      url: response.url,
    }
    config.onResult({ init, result: entity.parse(init) })
  }

  return {
    firstPage: config.firstPage,
    name: config.name,
    shouldKeepResponse,
    handleResponseData,
    handleResponseFinished,
  }
}

export { make }
export type { Config, Remote }
