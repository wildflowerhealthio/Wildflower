import { Difference, Suggestion } from '@wildflowerhealthio/importer-fundamentals'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ReasonTag from './reason-tag.ts'

/** Every reason a suggestion can give. */
const REASONS: readonly Suggestion.Reason[] = [
  Suggestion.SeveralIdentifierMatches(),
  Suggestion.OneIdentifierMatch(),
  Suggestion.NoMatch(),
  Suggestion.NameMatchReferenced(),
  Suggestion.NameMatchNotReferenced(),
]

describe('ReasonTag.decidedReasonOf', () => {
  it('keeps exactly the reasons of a record that does not need a decision', () => {
    expect(
      REASONS.map((reason) => [
        reason._tag,
        Option.isSome(ReasonTag.decidedReasonOf(reason)),
        Suggestion.needsDecision(reason),
      ])
    ).toEqual([
      ['SeveralIdentifierMatches', false, true],
      ['OneIdentifierMatch', true, false],
      ['NoMatch', true, false],
      ['NameMatchReferenced', false, true],
      ['NameMatchNotReferenced', true, false],
    ])
  })
})

describe('ReasonTag.reasonTagOf', () => {
  it('tags each reason of a record decided automatically, an identifier match by what merging into it writes', () => {
    const gap = Difference.FillsGap({ field: 'gender' })
    const overwrite = Difference.Overwrites({ field: 'telecom' })
    expect([
      ReasonTag.reasonTagOf(Suggestion.OneIdentifierMatch(), [], 'LinkToExisting'),
      ReasonTag.reasonTagOf(Suggestion.OneIdentifierMatch(), [], 'Update'),
      ReasonTag.reasonTagOf(Suggestion.OneIdentifierMatch(), [gap], 'Update'),
      ReasonTag.reasonTagOf(Suggestion.OneIdentifierMatch(), [gap, overwrite], 'LinkToExisting'),
      ReasonTag.reasonTagOf(Suggestion.NoMatch(), [gap], 'Create'),
      ReasonTag.reasonTagOf(Suggestion.NameMatchNotReferenced(), [], 'Create'),
    ]).toEqual([
      'Identifier match · same as existing',
      'Identifier match · adds an identifier or a link',
      'Identifier match · 1 field differs',
      'Identifier match · 2 fields differ',
      'New · no match',
      'New · not referenced',
    ])
  })
})
