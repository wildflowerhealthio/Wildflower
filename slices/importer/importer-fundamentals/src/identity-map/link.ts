/**
 * A link: a referent with the link target its choice resolved to, what the
 * plan is built from; and a linked resource, a link that landed on one.
 *
 * @packageDocumentation
 */

import { Option } from 'effect'

import * as LinkTarget from './link-target.ts'
import type * as LinkableResource from './linkable-resource.ts'
import type * as Referent from './referent.ts'

/** One referent and the resource it is linked to, or none. */
interface Type {
  readonly referent: Referent.Type
  readonly target: LinkTarget.Type
}

/** A link that landed on a resource: the referent, and the resource its target holds. */
interface LinkedResource {
  readonly referent: Referent.Type
  readonly resource: LinkableResource.WithId
}

/** `link` as a linked resource; `None` when its target is `Unlinked`. */
const tryIntoLinkedResource = ({ referent, target }: Type): Option.Option<LinkedResource> =>
  Option.map(LinkTarget.tryIntoResource(target), (resource) => ({ referent, resource }))

export { tryIntoLinkedResource }
export type { LinkedResource, Type }
