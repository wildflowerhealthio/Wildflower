import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as OfferedFields from './offered-fields.ts'
import * as RecordChoice from './record-choice.ts'
import * as Suggestion from './suggestion.ts'

/** Covers what a suggestion holds and which of its reasons need a decision. */

const NO_FIELD = OfferedFields.make({ gapFilling: [], overwriting: [], identifiersToAdd: [] })

describe('Suggestion.make', () => {
  it('should hold its choice, or none to leave the record undecided, beside its reason', () => {
    // Arrange / Act
    const suggestions = [
      Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), Suggestion.NoMatch()),
      Suggestion.make(Option.none(), Suggestion.SeveralIdentifierMatches()),
    ]

    // Assert
    expect(suggestions).toEqual([
      { choice: Option.some(RecordChoice.SaveAsNewRecord()), reason: Suggestion.NoMatch() },
      { choice: Option.none(), reason: Suggestion.SeveralIdentifierMatches() },
    ])
  })
})

describe('Suggestion.needsDecision', () => {
  it('should list a record under Needs a decision when a name match is referenced or several stored records are it', () => {
    // Arrange
    const reasons: readonly Suggestion.Reason[] = [
      Suggestion.IdentifierMatchSameAsExisting({ offeredFields: NO_FIELD }),
      Suggestion.IdentifierMatchFieldsDiffer({
        offeredFields: OfferedFields.make({
          gapFilling: ['gender'],
          overwriting: [],
          identifiersToAdd: [],
        }),
      }),
      Suggestion.NoMatch(),
      Suggestion.NotReferenced(),
      Suggestion.NameMatchReferenced(),
      Suggestion.SeveralIdentifierMatches(),
    ]

    // Act
    const needsDecision = reasons.map((reason) => [reason._tag, Suggestion.needsDecision(reason)])

    // Assert
    expect(needsDecision).toEqual([
      ['IdentifierMatchSameAsExisting', false],
      ['IdentifierMatchFieldsDiffer', false],
      ['NoMatch', false],
      ['NotReferenced', false],
      ['NameMatchReferenced', true],
      ['SeveralIdentifierMatches', true],
    ])
  })
})
