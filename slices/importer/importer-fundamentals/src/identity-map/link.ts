/**
 * A link: a referent with the link target its choice resolved to, what the
 * plan is built from.
 *
 * @packageDocumentation
 */

import type * as LinkTarget from './link-target.ts'
import type * as Referent from './referent.ts'

/** One referent and the resource it is linked to, or none. */
interface Type {
  readonly referent: Referent.Type
  readonly target: LinkTarget.Type
}

export type { Type }
