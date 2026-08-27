import { Option } from 'effect'

import type * as Extraction from './extraction.ts'
import type * as HttpResponseKind from './http-response-kind.ts'

/**
 * An HTTP source you can extract resources from, as one first-class value: it
 * both claims traffic as its own — so {@link resolve} can rank it against the
 * other sources — and carries the two things a consumer drives once traffic is
 * in hand: the response kinds to extract with, and how to read a source root
 * off a single URL.
 *
 * @typeParam TResources - The resource type this source's response kinds decode
 *   to
 *
 * @remarks
 * The recognition fields (`name` / `specificity` / `claims`) and the extraction
 * fields (`tag` / `responseKinds` / `rootOf`) sit on one value so it is passed
 * straight to {@link resolve}, which returns the whole record — no parallel
 * lookup keyed by name.
 *
 * Recognition is how a source claims a set of responses with **no user
 * configuration** — "this traffic is mine, and here is how specific that claim
 * is". A consumer holding nothing but captured traffic reads *which* source
 * produced it off the traffic itself: each source declares its claim (by URL or
 * payload shape) next to its response kinds, and `resolve` picks between the
 * ones that claim.
 *
 * `specificity` is a plain number, higher wins. The intended ranking across the
 * sources is portal-specific (a named patient portal) above protocol-generic
 * (any FHIR server) above catch-all (a recorder that claims everything) — a
 * convention between the sources, not an enum this package polices, so a new
 * kind of source needs no change here. Keep the values spread out enough to
 * insert between.
 *
 * Both the response kinds and `rootOf` are **per-URL** by design: a source keys
 * each resource under the root of the URL it arrived on, and `rootOf` reads
 * that same root off one URL. Neither infers a single root for a whole capture,
 * so a capture that reached several servers keeps each apart. A consumer
 * collects the *set* of roots the capture named rather than choosing one.
 */
interface Source<TResources> {
  /** Stable identifier, for logging and a consumer's own lookup. */
  readonly name: string
  /** Higher wins. See the ranking convention in the remarks. */
  readonly specificity: number
  /**
   * Claims a set of responses as this source's, with no user configuration.
   * Must be pure and total, and sees the same structural
   * {@link Extraction.Input}s the extraction runner does — a source's claim and
   * the response kinds it speaks for read the same evidence.
   */
  readonly claims: (responses: readonly Extraction.Input[]) => boolean
  /** The source's stable tag, the discriminator a consumer reports. */
  readonly tag: string
  /** The response kinds `Extraction.run` folds a set of responses through. */
  readonly responseKinds: readonly HttpResponseKind.HttpResponseKind<TResources>[]
  /**
   * The source root a single URL was served from, or `None` when the URL
   * names no resource this source understands. The per-URL primitive a
   * consumer folds over every response to collect a capture's distinct
   * source roots.
   */
  readonly rootOf: (url: string) => Option.Option<string>
}

/**
 * Pick the most specific source that claims `responses`.
 *
 * @typeParam TSource - The caller's source type; whatever it carries alongside
 *   the recognition fields (`tag`, `responseKinds`, `rootOf`) comes back
 *   untouched
 * @param sources - The candidates, in any order
 * @param responses - The responses to offer them
 * @returns The claiming candidate with the highest `specificity`, or `None`
 *   when none claims
 *
 * @remarks
 * Generic in the caller's source so its payload rides through on the returned
 * value rather than being looked up by name — the constraint is only the two
 * recognition fields `resolve` actually reads.
 *
 * Ties break toward the earliest candidate in `sources`, so the result is
 * deterministic even when two sources declare the same specificity — but a tie
 * means the ranking is under-specified, and the fix is to separate the two
 * `specificity` values, not to rely on list order.
 *
 * Every candidate's `claims` runs, including ones that cannot win: the
 * predicates are pure and the candidate list is a handful of sources, so
 * short-circuiting would buy nothing and would make the result depend on the
 * order they were listed in.
 */
const resolve = <TSource extends Pick<Source<unknown>, 'specificity' | 'claims'>>(
  sources: readonly TSource[],
  responses: readonly Extraction.Input[]
): Option.Option<TSource> =>
  Option.fromNullable(
    sources
      .filter((source) => source.claims(responses))
      .reduce<TSource | undefined>(
        (best, candidate) =>
          best === undefined || candidate.specificity > best.specificity ? candidate : best,
        undefined
      )
  )

export { resolve }
export type { Source }
