/**
 * Verb labels for the consent view — the granted access written as a
 * natural-language list (`spec.md §1`, joined to read as a sentence). Strictly
 * 1:1 with CRUDS; there is no "view = read + search" shorthand. A v1 (word)
 * scope labels by its Read/Write parts so the sentence matches its picker,
 * rather than leaking the expanded CRUDS verbs.
 */

import {
  accessLetters,
  sortActions,
  WORD_COMPONENT_LABEL,
  WORD_COMPONENTS,
  wordComponentsOf,
} from './access.ts'
import type { Access, Action } from './model.ts'
import { VERB } from './model.ts'

/** Join parts as a sentence list: `"A"`, `"A and B"`, `"A, B and C"`; empty for none. */
const sentenceJoin = (parts: readonly string[]): string => {
  if (parts.length <= 1) return parts.join('')
  const last = parts.at(-1) ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${last}`
}

/**
 * A sentence-style label for a set of CRUDS actions, in canonical order:
 * `"Read"`, `"Read and Search"`, `"Create, Read and Search"`. This is the text
 * of the tappable verb token, so it reads inline: "*…can* **Create, Read and
 * Search** *your* **Observation**".
 */
export const verbLabel = (actions: Iterable<Action>): string =>
  sentenceJoin(sortActions(actions).map((a) => VERB[a]))

/**
 * The verb label for an access value. A v1 (`word`) scope reads by its
 * Read/Write parts (`"Read"`, `"Write"`, `"Read and Write"`) so the sentence
 * matches the v1 multiselect; a v2 (`letters`) scope reads its CRUDS verbs.
 */
export const accessVerbLabel = (access: Access): string => {
  if (access.kind !== 'letters') {
    const selected = wordComponentsOf(access)
    return sentenceJoin(
      WORD_COMPONENTS.filter((c) => selected[c]).map((c) => WORD_COMPONENT_LABEL[c])
    )
  }
  return verbLabel(accessLetters(access))
}
