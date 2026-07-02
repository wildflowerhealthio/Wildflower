/**
 * The **cruds permission style** — a permission expressed as a set of v2 `cruds`
 * interactions. The single `cruds` letters are *interactions* (`c`reate, `r`ead,
 * `u`pdate, `d`elete, `s`earch); a {@link BasePermission} is any set of them, held as a
 * `Set` (the closest mirror of `scopes-rust`'s `u8` bit set) and canonicalized to
 * `c,r,u,d,s` order on serialize. The SMART v1 word style (`read`/`write`/`*`) is a
 * separate, FHIR-only concern ({@link ReadWritePermissionStyle}); the two are never
 * converted into one another — each is edited and compared in its own interactions.
 *
 * Namespace module (`import { CrudsPermissionStyle } from 'scopes-core'`).
 */

import { sentenceJoin } from '../../../language-util.ts'
import { BasePermission } from './permission-style.ts'

/** Sort an arbitrary interaction collection into canonical `c r u d s` order, deduped. */

/** The five SMART v2 cruds interactions — used by FHIR v2 *and* Wildflower. */
class CrudsPermission extends BasePermission<CrudsPermission.Interaction> {
  kind = 'cruds' as const
  items = [
    { id: 'c', name: 'Create', code: 'c' },
    { id: 'r', name: 'Read', code: 'r' },
    { id: 'u', name: 'Update', code: 'u' },
    { id: 'd', name: 'Destroy', code: 'd' },
    { id: 's', name: 'Search', code: 's' },
  ] as const

  make(interactions: Iterable<CrudsPermission.Interaction>): CrudsPermission {
    return new CrudsPermission(interactions)
  }

  /**
   * Parse a v2 letter-bag segment (`rs`, `cruds`, …), or `null` for empty/invalid.
   * Rejects the SMART v1 words (`read`/`write`/`*`) — they contain non-cruds
   * letters — which is what keeps v1 out of the Wildflower grammar.
   */
  static parse(segment: string): CrudsPermission | null {
    const out: CrudsPermission.Interaction[] = []
    for (const ch of segment) {
      if (ch === 'c' || ch === 'r' || ch === 'u' || ch === 'd' || ch === 's') out.push(ch)
      else return null
    }
    return out.length > 0 ? new CrudsPermission(out) : null
  }

  /** Render the permission segment of a scope string: canonical letters (empty → `''`). */
  serialize(): string | null {
    const sorted = this.toArray()
    return sorted.length > 0 ? sorted.join('') : null
  }

  label(): string {
    const labels = this.toArray().map((id) => INTERACTION_LABELS[id])
    return sentenceJoin(labels)
  }
}

const INTERACTION_LABELS: Record<CrudsPermission.Interaction, string> = {
  c: 'Create',
  r: 'Read',
  u: 'Update',
  d: 'Destroy',
  s: 'Search',
} as const

// oxlint-disable import/group-exports
namespace CrudsPermission {
  export type Interaction = 'c' | 'r' | 'u' | 'd' | 's'
  namespace Interaction {
    export const all: readonly Interaction[] = ['c', 'r', 'u', 'd', 's']
    export const LABELS = INTERACTION_LABELS
  }
  export const empty = new CrudsPermission([])
}

export default CrudsPermission
