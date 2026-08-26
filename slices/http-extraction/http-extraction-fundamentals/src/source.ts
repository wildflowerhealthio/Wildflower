import type { Option } from 'effect'

import type * as HttpResponseKind from './http-response-kind.ts'
import type * as Recognizer from './recognizer.ts'

/**
 * An HTTP source you can extract entities from, as one first-class value: its
 * {@link Recognizer.Recognizer} (so `Recognizer.resolve` can rank it against
 * the others), plus the two things a consumer drives once traffic is in
 * hand — the entities to extract with, and how to read a source root off a
 * single URL.
 *
 * @typeParam TResources - The resource type this source's entities decode to
 *
 * @remarks
 * Extends `Recognizer` rather than wrapping it so the value is passed
 * straight to `Recognizer.resolve`, which returns the whole record — `tag`,
 * `entities`, and `rootOf` ride along, no parallel lookup by name.
 *
 * Both the entities and `rootOf` are **per-URL** by design: a source keys
 * each resource under the root of the URL it arrived on, and `rootOf` reads
 * that same root off one URL. Neither infers a single root for a whole
 * capture, so a capture that reached several servers keeps each apart. A
 * consumer collects the *set* of roots the capture named rather than choosing
 * one.
 */
interface Source<TResources> extends Recognizer.Recognizer {
  /** The source's stable tag, the discriminator a consumer reports. */
  readonly tag: string
  /** The entities `Extraction.run` folds a set of responses through. */
  readonly entities: readonly HttpResponseKind.HttpResponseKind<TResources>[]
  /**
   * The source root a single URL was served from, or `None` when the URL
   * names no resource this source understands. The per-URL primitive a
   * consumer folds over every response to collect a capture's distinct
   * source roots.
   */
  readonly rootOf: (url: string) => Option.Option<string>
}

export type { Source }
