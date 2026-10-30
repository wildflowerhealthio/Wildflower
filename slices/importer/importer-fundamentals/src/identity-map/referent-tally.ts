/**
 * How many records a batch's referents are linked to, and how many referents are
 * nowhere: the review's one-line summary of its link targets.
 *
 * @packageDocumentation
 */

import { Array, HashSet, pipe } from 'effect'

import * as LinkTarget from './link-target.ts'
import * as LinkableResource from './linkable-resource.ts'

/** How many records the referents are linked to, and how many referents are unlinked. */
interface Type {
  /** Stored records linked to, as they are. */
  readonly onServer: number
  /** Records this import writes: decoded ones, over a stored copy or not, and provisional ones. */
  readonly fromImport: number
  /** Referents not linked. */
  readonly unlinked: number
}

/**
 * The tally of `linkTargets`: stored records as they are, and the ones this
 * import writes (decoded, over a stored copy or not, and provisional), each
 * counted once however many referents share it, and once in all when a stored
 * link is to a record this import writes over; and how many referents are
 * nowhere.
 */
const of = (linkTargets: Iterable<LinkTarget.Type>): Type => {
  const targets = Array.fromIterable(linkTargets)
  const recordsAmong = (isCounted: (target: LinkTarget.Type) => boolean): HashSet.HashSet<string> =>
    pipe(
      targets,
      Array.filter(isCounted),
      Array.filterMap(LinkTarget.resourceIfLinked),
      Array.map(LinkableResource.literalReferenceOf),
      HashSet.fromIterable
    )
  const fromImport = recordsAmong(
    (target) => LinkTarget.is('Decoded')(target) || LinkTarget.is('Provisional')(target)
  )
  return {
    onServer: HashSet.size(HashSet.difference(recordsAmong(LinkTarget.is('Stored')), fromImport)),
    fromImport: HashSet.size(fromImport),
    unlinked: Array.countBy(targets, LinkTarget.is('Unlinked')),
  }
}

export { of }
export type { Type }
