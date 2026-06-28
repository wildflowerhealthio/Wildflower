/**
 * Access-rights logic — the bridge between SMART v1 *words* and v2 *letter bags*,
 * mirroring `scopes-rust`'s `AccessRights` (`scope/resource/access_rights.rs`).
 * A v1 scope's access is edited as a two-option multiselect — **Read** and
 * **Write** — the only coarse parts a v1 client can express; both ⇒ `*` (`star`).
 */

import type { Access, Action } from './model.ts'
import { ACTION_ORDER } from './model.ts'

/** CRUDS bits each v1 word grants (`read` = r,s; `write` = c,u,d; `star` = all). */
const READ_LETTERS: readonly Action[] = ['r', 's']
const WRITE_LETTERS: readonly Action[] = ['c', 'u', 'd']
const STAR_LETTERS: readonly Action[] = ['c', 'r', 'u', 'd', 's']

/** Sort an arbitrary letter collection into canonical `c r u d s` order, deduped. */
export const sortActions = (actions: Iterable<Action>): Action[] => {
  const set = new Set(actions)
  return ACTION_ORDER.filter((a) => set.has(a))
}

/** A v2 letter-bag access (canonical order, deduped). */
export const lettersAccess = (actions: Iterable<Action>): Access => ({
  kind: 'letters',
  letters: sortActions(actions),
})

/** The SMART v1 word accesses. */
export const readAccess: Access = { kind: 'read' }
export const writeAccess: Access = { kind: 'write' }
export const starAccess: Access = { kind: 'star' }

/**
 * The CRUDS letters this access grants, regardless of v1/v2 form — the common
 * currency for coverage/lock checks (mirrors Rust's `AccessRights::bits`).
 */
export const accessLetters = (access: Access): readonly Action[] => {
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
export const isEmptyAccess = (access: Access): boolean =>
  access.kind === 'letters' && access.letters.length === 0

/** Does `access` include `action`, by CRUDS bits? */
export const accessHas = (access: Access, action: Action): boolean =>
  accessLetters(access).includes(action)

/** Is `subset`'s coverage a subset of `superset`'s, by CRUDS bits? */
export const accessSubsetOf = (subset: Access, superset: Access): boolean => {
  const covering = new Set(accessLetters(superset))
  return accessLetters(subset).every((a) => covering.has(a))
}

/** Whether the access is edited as a v1 `word` (Read/Write) or v2 `letters`. */
export const accessForm = (access: Access): 'word' | 'letters' =>
  access.kind === 'letters' ? 'letters' : 'word'

/** Render the access segment of a scope string: a v1 word, or canonical letters. */
export const serializeAccess = (access: Access): string => {
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
export const parseAccess = (segment: string): Access | null => {
  if (segment === 'read') return { kind: 'read' }
  if (segment === 'write') return { kind: 'write' }
  if (segment === '*') return { kind: 'star' }
  const letters: Action[] = []
  for (const ch of segment) {
    if (ch === 'c' || ch === 'r' || ch === 'u' || ch === 'd' || ch === 's') letters.push(ch)
    else return null
  }
  return letters.length > 0 ? lettersAccess(letters) : null
}

// ── v1 word components (Read / Write) ───────────────────────────────────────

/** The two selectable parts of a SMART v1 scope. Both ⇒ `*`; neither ⇒ no scope. */
export type WordComponent = 'read' | 'write'

/** The components in display order. */
export const WORD_COMPONENTS: readonly WordComponent[] = ['read', 'write']

/** User-facing label for each component (1:1 with the SMART v1 word). */
export const WORD_COMPONENT_LABEL: Readonly<Record<WordComponent, string>> = {
  read: 'Read',
  write: 'Write',
}

const COMPONENT_LETTERS: Readonly<Record<WordComponent, readonly Action[]>> = {
  read: READ_LETTERS,
  write: WRITE_LETTERS,
}

/** Does `access` fully cover this component's CRUDS bits? (`null` ⇒ no.) */
export const coversComponent = (access: Access | null, component: WordComponent): boolean => {
  if (access === null) return false
  const have = new Set(accessLetters(access))
  return COMPONENT_LETTERS[component].every((a) => have.has(a))
}

/** Which components a given access currently selects (by CRUDS bits). */
export const wordComponentsOf = (
  access: Access | null
): Readonly<Record<WordComponent, boolean>> => ({
  read: coversComponent(access, 'read'),
  write: coversComponent(access, 'write'),
})

/**
 * Build the v1 word {@link Access} from a Read/Write selection: both ⇒ `star`,
 * one ⇒ that word, neither ⇒ `null` (the scope is dropped).
 */
export const accessFromComponents = (
  parts: Readonly<Record<WordComponent, boolean>>
): Access | null => {
  if (parts.read && parts.write) return { kind: 'star' }
  if (parts.read) return { kind: 'read' }
  if (parts.write) return { kind: 'write' }
  return null
}
