/**
 * Verb labels for the consent view — the granted access written as a
 * natural-language list (`spec.md §1`, joined to read as a sentence). Strictly
 * 1:1 with CRUDS; there is no "view = read + search" shorthand. A v1 (word)
 * scope labels by its Read/Write parts so the sentence matches its picker. A
 * view-model concern (display copy) with no `scopes-rust` counterpart.
 *
 * Namespace module (`import { Verbs } from 'scopes-core'`).
 */

import { AccessRights } from '../domain/index.ts'
import * as Words from './words.ts'

/**
 * The five user-facing verbs, strictly 1:1 with CRUDS (no merging, no
 * "view = read + search" collapse). See `spec.md §1`.
 */
export const VERB: Readonly<Record<AccessRights.Action, string>> = {
  c: 'Create',
  r: 'Read',
  u: 'Update',
  d: 'Destroy',
  s: 'Search',
}

/** Join parts as a sentence list: `"A"`, `"A and B"`, `"A, B and C"`; empty for none. */
const sentenceJoin = (parts: readonly string[]): string => {
  if (parts.length <= 1) return parts.join('')
  const last = parts.at(-1) ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${last}`
}

/**
 * A sentence-style label for a set of CRUDS actions, in canonical order:
 * `"Read"`, `"Read and Search"`, `"Create, Read and Search"`.
 */
export const label = (actions: Iterable<AccessRights.Action>): string =>
  sentenceJoin(AccessRights.sortActions(actions).map((a) => VERB[a]))

/**
 * The verb label for an access value. A v1 (`word`) scope reads by its Read/Write
 * parts (`"Read"`, `"Write"`, `"Read and Write"`) so the sentence matches the v1
 * multiselect; a v2 (`letters`) scope reads its CRUDS verbs.
 */
export const accessLabel = (access: AccessRights.Any): string => {
  if (access.kind !== 'letters') {
    const selected = Words.of(access)
    return sentenceJoin(Words.COMPONENTS.filter((c) => selected[c]).map((c) => Words.LABEL[c]))
  }
  return label(AccessRights.lettersOf(access))
}
