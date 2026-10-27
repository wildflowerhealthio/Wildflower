/**
 * The referent link choices: the reviewer's `LinkChoice` for every referent
 * an import discovers, by `Referent.key`. What the identity map screen holds
 * and a decoded file is resolved on.
 *
 * @remarks
 * Held beside the per-format selections, never inside them: `StagedImport`
 * keeps exclusions and edits only. A referent missing from it takes its
 * default (`LinkChoice.forReferent`).
 *
 * @packageDocumentation
 */

import { HashMap } from 'effect'

import type * as LinkChoice from './link-choice.ts'

type Type = HashMap.HashMap<string, LinkChoice.Type>

/** No choice made for any referent: every referent takes its default. */
const empty: Type = HashMap.empty()

export { empty }
export type { Type }
