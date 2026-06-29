/**
 * CRUDS access rights — the permission half of every resource scope, mirroring
 * `scopes-rust`'s `AccessRights` / `Repr` (`scope/resource/access_rights.rs`).
 * The SMART v1 words (`read`/`write`/`*`) round-trip verbatim; a v2 letter bag
 * normalizes to canonical `c,r,u,d,s` order.
 *
 * Namespace module (`import { AccessRights } from 'scopes-core'`): the access
 * union is {@link AccessRights}, with `AccessRights.parse`, `AccessRights.letters`, …
 */

/** A SMART v2 CRUDS permission letter. Canonical order is always `c r u d s`. */
export type Action = 'c' | 'r' | 'u' | 'd' | 's'

/** Canonical CRUDS order (SMART v2). Every letter list is sorted into this order. */
export const ACTION_ORDER: readonly Action[] = ['c', 'r', 'u', 'd', 's']

/**
 * The access rights of one scope — a faithful mirror of Rust's `Repr`. The v1
 * words round-trip verbatim (`read` = r,s; `write` = c,u,d; `star` = `*` = all
 * five); a v2 `letters` bag normalizes to canonical order. The variant is
 * load-bearing for the UI — `letters` renders the CRUDS cells, the words render
 * the Read/Write multiselect.
 */
export type AccessRights =
  | { readonly kind: 'read' }
  | { readonly kind: 'write' }
  | { readonly kind: 'star' }
  | { readonly kind: 'letters'; readonly letters: readonly Action[] }

/** CRUDS bits each v1 word grants (`read` = r,s; `write` = c,u,d; `star` = all). */
const READ_LETTERS: readonly Action[] = ['r', 's']
const WRITE_LETTERS: readonly Action[] = ['c', 'u', 'd']
const STAR_LETTERS: readonly Action[] = ['c', 'r', 'u', 'd', 's']

/** The SMART v1 word accesses. */
export const read: AccessRights = { kind: 'read' }
export const write: AccessRights = { kind: 'write' }
export const star: AccessRights = { kind: 'star' }

/** Sort an arbitrary letter collection into canonical `c r u d s` order, deduped. */
export const sortActions = (actions: Iterable<Action>): Action[] => {
  const set = new Set(actions)
  return ACTION_ORDER.filter((a) => set.has(a))
}

/** A v2 letter-bag access (canonical order, deduped). */
export const letters = (actions: Iterable<Action>): AccessRights => ({
  kind: 'letters',
  letters: sortActions(actions),
})

/**
 * The CRUDS letters this access grants, regardless of v1/v2 form — the common
 * currency for coverage/lock checks (mirrors Rust's `AccessRights::bits`).
 */
export const lettersOf = (access: AccessRights): readonly Action[] => {
  switch (access.kind) {
    case 'read':
      return READ_LETTERS
    case 'write':
      return WRITE_LETTERS
    case 'star':
      return STAR_LETTERS
    case 'letters':
      return access.letters
    default: {
      const exhaustive: never = access
      throw new Error(`unknown access kind: ${String(exhaustive)}`)
    }
  }
}

/** Whether the access grants nothing (an empty letter bag). */
export const isEmpty = (access: AccessRights): boolean =>
  access.kind === 'letters' && access.letters.length === 0

/** Does `access` include `action`, by CRUDS bits? */
export const has = (access: AccessRights, action: Action): boolean =>
  lettersOf(access).includes(action)

/** Is `subset`'s coverage a subset of `superset`'s, by CRUDS bits? */
export const subsetOf = (subset: AccessRights, superset: AccessRights): boolean => {
  const covering = new Set(lettersOf(superset))
  return lettersOf(subset).every((a) => covering.has(a))
}

/** Whether the access is edited as a v1 `word` (Read/Write) or v2 `letters`. */
export const form = (access: AccessRights): 'word' | 'letters' =>
  access.kind === 'letters' ? 'letters' : 'word'

/** Render the access segment of a scope string: a v1 word, or canonical letters. */
export const serialize = (access: AccessRights): string => {
  switch (access.kind) {
    case 'read':
      return 'read'
    case 'write':
      return 'write'
    case 'star':
      return '*'
    case 'letters':
      return sortActions(access.letters).join('')
    default: {
      const exhaustive: never = access
      throw new Error(`unknown access kind: ${String(exhaustive)}`)
    }
  }
}

/**
 * Parse an access segment into the richest form, preserving v1/v2 spelling, or
 * `null` for an empty/invalid segment (a stray non-CRUDS letter). Mirrors
 * `AccessRights::parse_segment`: `read`/`write`/`*` stay words; letter bags
 * normalize.
 */
export const parse = (segment: string): AccessRights | null => {
  if (segment === 'read') return read
  if (segment === 'write') return write
  if (segment === '*') return star
  const out: Action[] = []
  for (const ch of segment) {
    if (ch === 'c' || ch === 'r' || ch === 'u' || ch === 'd' || ch === 's') out.push(ch)
    else return null
  }
  return out.length > 0 ? letters(out) : null
}
