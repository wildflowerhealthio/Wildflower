import type { MatchGrade, ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { FastCheck as fc, HashMap, Match } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ImportMatch from '../import-match.ts'
import {
  discoverOnTestClock,
  fileOf,
  keyOf,
  patient,
  practitioner,
  SOURCE_PATIENT,
  SOURCE_PRACTITIONER,
} from './identity-map.test-helpers.ts'
import type * as LinkChoice from './link-choice.ts'
import type * as LinkableResource from './linkable-resource.ts'
import * as ReferentMatch from './referent-match.ts'
import type * as Referent from './referent.ts'

/**
 * Drives `ReferentMatch` over candidates as `ResourceMatch.matchAll` grades
 * them: a referent's default is read off its own candidates, with no request.
 */

/** The referents `resources` hold, in order. */
const referentsOf = (...resources: readonly LinkableResource.WithId[]): readonly Referent.Type[] =>
  discoverOnTestClock(fileOf(...resources))

/** The only referent `resource` is. */
const onlyReferent = (resource: LinkableResource.WithId): Referent.Type => {
  const [referent] = referentsOf(resource)
  if (referent === undefined) throw new Error('expected one referent')
  return referent
}

/** A candidate `resource` graded `grade`, found `by`. */
const candidate = (
  resource: LinkableResource.WithId,
  grade: MatchGrade.Type,
  by: ResourceMatch.Evidence = grade === 'certain' ? 'identifier' : 'name'
): ResourceMatch.Candidate => ({ resource, grade, by })

/** A choice as `<tag> <literal reference>`, the reference for one over a stored resource. */
const describeChoice = (choice: LinkChoice.Type): string =>
  Match.valueTags(choice, {
    CreateResource: () => 'CreateResource',
    UpdateStoredResource: ({ resource }) =>
      `UpdateStoredResource ${resource.resourceType}/${resource.id}`,
    LinkToStoredResource: ({ resource }) =>
      `LinkToStoredResource ${resource.resourceType}/${resource.id}`,
  })

const TYRA = onlyReferent(patient({ id: 'p-1' }))
const STORED_TYRA = patient({ id: 's-1', system: 'https://device.example/id' })
const OTHER_TYRA = patient({ id: 's-2', system: 'https://device.example/id' })

const defaultOf = (
  referent: Referent.Type,
  ...candidates: readonly ResourceMatch.Candidate[]
): string => describeChoice(ReferentMatch.defaultChoice(referent, candidates))

describe('ReferentMatch.defaultChoice', () => {
  it('should give New when nothing matched', () => {
    expect(defaultOf(TYRA)).toBe('CreateResource')
  })

  it('should link to the one stored record the referent’s identifiers name', () => {
    expect(defaultOf(TYRA, candidate(STORED_TYRA, 'certain'))).toBe(
      'LinkToStoredResource Patient/s-1'
    )
  })

  it('should link to the one stored record graded probable by name and birth date', () => {
    expect(defaultOf(TYRA, candidate(STORED_TYRA, 'probable'))).toBe(
      'LinkToStoredResource Patient/s-1'
    )
  })

  it('should link to the one probable record whatever possible ones matched beside it', () => {
    expect(
      defaultOf(TYRA, candidate(STORED_TYRA, 'probable'), candidate(OTHER_TYRA, 'possible'))
    ).toBe('LinkToStoredResource Patient/s-1')
  })

  it('should pick no default when two records are probable, as several found by identifier are', () => {
    expect(
      defaultOf(
        TYRA,
        candidate(STORED_TYRA, 'probable', 'identifier'),
        candidate(OTHER_TYRA, 'probable', 'identifier')
      )
    ).toBe('CreateResource')
  })

  it('should pick no default when every record is only possible', () => {
    expect(defaultOf(TYRA, candidate(STORED_TYRA, 'possible'))).toBe('CreateResource')
  })

  it('should update the stored copy under the decoded id, whatever else matched', () => {
    // Arrange: the copy a first import wrote, and a namesake
    const storedCopy = patient({ id: 'p-1' })

    // Act / Assert
    expect(
      defaultOf(
        TYRA,
        candidate(OTHER_TYRA, 'probable', 'identifier'),
        candidate(storedCopy, 'probable', 'identifier')
      )
    ).toBe('UpdateStoredResource Patient/p-1')
  })

  it('should keep the stored copy of a record the import implied, rather than write the name alone over it', () => {
    // Arrange
    const implied: Referent.Type = { ...TYRA, isImplied: true }

    // Act / Assert
    expect(defaultOf(implied, candidate(patient({ id: 'p-1' }), 'certain'))).toBe(
      'LinkToStoredResource Patient/p-1'
    )
  })

  it('should link a practitioner to a stored practitioner', () => {
    // Arrange
    const provider = onlyReferent(practitioner('r-1', 'Dr. Jan Smith'))
    const stored = practitioner('s-9', 'Jan Smith', 'https://device.example/id')

    // Act / Assert
    expect(defaultOf(provider, candidate(stored, 'probable'))).toBe(
      'LinkToStoredResource Practitioner/s-9'
    )
  })

  it('property: should link exactly when one candidate is certain or probable and none is the stored copy', () => {
    const gradeArbitrary = fc.constantFrom<MatchGrade.Type>('certain', 'probable', 'possible')
    fc.assert(
      fc.property(fc.array(gradeArbitrary, { maxLength: 4 }), (grades) => {
        // Arrange
        const candidates = grades.map((grade, index) =>
          candidate(patient({ id: `s-${index}`, system: 'https://device.example/id' }), grade)
        )
        const linkable = candidates.filter(({ grade }) => grade !== 'possible')

        // Act
        const choice = defaultOf(TYRA, ...candidates)

        // Assert
        expect(choice).toBe(
          linkable.length === 1
            ? `LinkToStoredResource Patient/${linkable[0]?.resource.id ?? ''}`
            : 'CreateResource'
        )
      })
    )
  })
})

describe('ReferentMatch.defaultChoices', () => {
  it('should give every referent the default its own record’s candidates give, keyed by referent', () => {
    // Arrange
    const referents = referentsOf(patient({ id: 'p-1' }), practitioner('r-1', 'Dr. Jan Smith'))
    const importMatch: ImportMatch.Type = {
      ...ImportMatch.empty,
      candidatesByRecord: HashMap.make(['Patient/p-1', [candidate(STORED_TYRA, 'certain')]]),
    }

    // Act
    const choices = ReferentMatch.defaultChoices(referents, importMatch)

    // Assert
    expect(
      HashMap.toEntries(HashMap.map(choices, describeChoice)).toSorted(([left], [right]) =>
        left.localeCompare(right)
      )
    ).toEqual(
      [
        [keyOf('Patient', SOURCE_PATIENT, 'p-1'), 'LinkToStoredResource Patient/s-1'],
        [keyOf('Practitioner', SOURCE_PRACTITIONER, 'r-1'), 'CreateResource'],
      ].toSorted(([left = ''], [right = '']) => left.localeCompare(right))
    )
  })
})
