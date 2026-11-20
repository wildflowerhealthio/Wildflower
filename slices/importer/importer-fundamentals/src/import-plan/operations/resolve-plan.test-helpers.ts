import { Effect, Equal } from 'effect'

import * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedCopy from '../entities/imported-copy.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import type * as PlanResolution from '../entities/plan-resolution.ts'
import type * as RecordChoice from '../entities/record-choice.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import { locateReferences } from './locate-references.ts'
import { resolvePlan } from './resolve-plan.ts'
import { suggestPlan } from './suggest-plan.ts'

/**
 * Builders for the tests of resolving a plan: a plan of copies as
 * `planImport` suggests it, the reviewer's choices over it, a minter that
 * counts, and the plan resolved with it.
 */

/** The plan of `copies`, grouped into records as `planImport` groups them, suggested from `storedMatch`. */
const planOf = (
  copies: readonly ImportedCopy.Type[],
  storedMatch: StoredMatch.Type = StoredMatch.empty
): ImportPlan.Type => {
  const records = ImportedRecord.fromCopies(copies)
  return suggestPlan(records, locateReferences(records), storedMatch)
}

/** {@link planOf} `copies`, the record of each copy of `choices` given its choice. */
const planWith = (
  copies: readonly ImportedCopy.Type[],
  choices: readonly (readonly [ImportedCopy.Type, RecordChoice.Type])[] = [],
  storedMatch: StoredMatch.Type = StoredMatch.empty
): ImportPlan.Type =>
  choices.reduce(
    (plan, [copy, choice]) => ImportPlan.choose(plan, [ImportedCopy.recordKeyOf(copy)], choice),
    planOf(copies, storedMatch)
  )

/** A minter that counts: `minted-1`, `minted-2`, …. */
const countingMinter = (): (() => string) => {
  let minted = 0
  return () => {
    minted += 1
    return `minted-${minted}`
  }
}

/** `plan` resolved with a counting minter. */
const resolutionOf = (plan: ImportPlan.Type): PlanResolution.Type =>
  Effect.runSync(resolvePlan(plan, countingMinter()))

/** The resolved record of `copy`'s record in `resolution`. */
const resolvedOf = (
  resolution: PlanResolution.Type,
  copy: ImportedCopy.Type
): PlanResolution.ResolvedRecord => {
  const key = ImportedCopy.recordKeyOf(copy)
  const resolved = resolution.records.find(({ planned }) => Equal.equals(planned.record.key, key))
  if (resolved === undefined) throw new Error(`No record of ${copy.reviewKey} is resolved`)
  return resolved
}

export { planOf, planWith, resolutionOf, resolvedOf }
