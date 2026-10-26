/**
 * A link: a referent with the destination its choice resolved to, what the
 * plan is built from.
 *
 * @packageDocumentation
 */

import type * as Destination from './destination.ts'
import type * as Referent from './referent.ts'

/** One referent and where it ends up. */
interface Type {
  readonly referent: Referent.Type
  readonly destination: Destination.Type
}

export type { Type }
