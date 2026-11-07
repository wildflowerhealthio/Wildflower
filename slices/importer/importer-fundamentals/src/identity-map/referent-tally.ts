/**
 * How many records a batch's referents are linked to: the review's one-line
 * summary of its link targets.
 *
 * @packageDocumentation
 */

import { Array, HashSet, pipe } from 'effect'

import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'

/** How many records the referents are linked to. */
interface Type {
  /** Stored records linked to, as they are. */
  readonly onServer: number
  /** Records this import writes: decoded ones, over a stored copy or not. */
  readonly fromImport: number
}

/**
 * The tally of `linkTargets`: stored records as they are, and the ones this
 * import writes (decoded, over a stored copy or not), each counted once
 * however many referents share it, and once in all when a stored link is to
 * a record this import writes over.
 */
const make = (linkTargets: Iterable<LinkTarget.Linked>): Type => {
  const targets = Array.fromIterable(linkTargets)
  const recordsAmong = (
    isCounted: (target: LinkTarget.Linked) => boolean
  ): HashSet.HashSet<string> =>
    pipe(
      targets,
      Array.filter(isCounted),
      Array.map(({ resource }) => LinkableResource.literalReferenceOf(resource)),
      HashSet.fromIterable
    )
  const fromImport = recordsAmong(LinkTarget.is('Decoded'))
  return {
    onServer: HashSet.size(HashSet.difference(recordsAmong(LinkTarget.is('Stored')), fromImport)),
    fromImport: HashSet.size(fromImport),
  }
}

export { make }
export type { Type }
