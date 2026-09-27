import { Arbitrary, DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import * as HumanName from './human-name.ts'

describe('FhirR4HumanName', () => {
  test('property: FHIR encode-decode round-trip', () => {
    fc.assert(
      fc.property(Arbitrary.make(HumanName.Schema), (humanName) => {
        const fhir = Schema.encodeSync(HumanName.Schema)(humanName)
        const decoded = Schema.decodeSync(HumanName.Schema)(fhir)
        expect(decoded).toSchemaEqual(HumanName.Schema, humanName)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('displayName', () => {
  it('should join the given names and the family name', () => {
    expect(HumanName.displayName([{ given: ['Ada', 'Augusta'], family: 'Lovelace' }])).toBe(
      'Ada Augusta Lovelace'
    )
  })

  it('should drop blank given parts rather than doubling the space between names', () => {
    expect(HumanName.displayName([{ given: ['Ada', '', ' Augusta '], family: 'Lovelace' }])).toBe(
      'Ada Augusta Lovelace'
    )
  })

  it('should fall back to the name text when the name has no parts', () => {
    expect(HumanName.displayName([{ text: ' Ada King ' }])).toBe('Ada King')
  })

  it('should skip a blank name for the next one on record', () => {
    expect(HumanName.displayName([{ given: [' '] }, { given: ['Ada'], family: 'Lovelace' }])).toBe(
      'Ada Lovelace'
    )
  })

  it('should be null when the record has no name', () => {
    expect(HumanName.displayName([])).toBeNull()
  })

  it('should show the official name over an old one listed first', () => {
    // Arrange
    const names = [
      { use: 'old', family: 'Smith', given: ['Jane'] },
      { use: 'official', family: 'Doe', given: ['Jane'] },
    ]

    // Act
    const name = HumanName.displayName(names)

    // Assert
    expect(name).toBe('Jane Doe')
  })

  it('should prefer an official name, then a usual one, then any other', () => {
    // Arrange
    const names = [
      { use: 'nickname', given: ['Addie'] },
      { use: 'usual', given: ['Ada'], family: 'King' },
      { use: 'official', given: ['Augusta Ada'], family: 'King' },
    ]

    // Act / Assert
    expect(HumanName.displayName(names)).toBe('Augusta Ada King')
    expect(HumanName.displayName(names.slice(0, 2))).toBe('Ada King')
  })

  it('should show a name with no use over a nickname', () => {
    expect(
      HumanName.displayName([
        { use: 'nickname', given: ['Nick'] },
        { given: ['Real'], family: 'Name' },
      ])
    ).toBe('Real Name')
  })

  it('should show a nickname when it is the only current name', () => {
    expect(
      HumanName.displayName([
        { use: 'old', given: ['Former'] },
        { use: 'nickname', given: ['Nick'] },
      ])
    ).toBe('Nick')
  })

  it('should keep record order between names of the same use', () => {
    expect(
      HumanName.displayName([
        { use: 'official', given: ['Ada'], family: 'Lovelace' },
        { use: 'official', given: ['Ada'], family: 'King' },
      ])
    ).toBe('Ada Lovelace')
  })

  it('should pass over a maiden name for the name in use', () => {
    expect(
      HumanName.displayName([
        { use: 'maiden', family: 'Byron', given: ['Ada'] },
        { family: 'Lovelace', given: ['Ada'] },
      ])
    ).toBe('Ada Lovelace')
  })

  it('should pass over a name whose period ended before now', () => {
    // Arrange
    const now = instant('2024-06-01T00:00:00Z')
    const names = [
      { use: 'official', family: 'Smith', given: ['Jane'], period: { end: '2020-01-01' } },
      { use: 'usual', family: 'Doe', given: ['Jane'] },
    ]

    // Act
    const name = HumanName.displayName(names, now)

    // Assert
    expect(name).toBe('Jane Doe')
  })

  it('should still show a name whose period ends after now', () => {
    // Arrange
    const now = instant('2024-06-01T00:00:00Z')
    const names = [
      { use: 'official', family: 'Smith', given: ['Jane'], period: { end: '2030-01-01' } },
      { use: 'usual', family: 'Doe', given: ['Jane'] },
    ]

    // Act / Assert
    expect(HumanName.displayName(names, now)).toBe('Jane Smith')
  })

  it('should keep a name current through the whole day its period ends on', () => {
    // Arrange — the last instant of the end date
    const names = [
      { use: 'official', family: 'Smith', given: ['Jane'], period: { end: '2024-06-01' } },
      { use: 'usual', family: 'Doe', given: ['Jane'] },
    ]

    // Act / Assert
    expect(HumanName.displayName(names, instant('2024-06-01T23:59:59.999Z'))).toBe('Jane Smith')
    expect(HumanName.displayName(names, instant('2024-06-02T00:00:00Z'))).toBe('Jane Doe')
  })

  it('should keep a name current through the whole month or year its period ends in', () => {
    // Arrange
    const endingIn = (end: string): readonly HumanName.Displayable[] => [
      { use: 'official', family: 'Smith', given: ['Jane'], period: { end } },
      { use: 'usual', family: 'Doe', given: ['Jane'] },
    ]

    // Act / Assert
    expect(HumanName.displayName(endingIn('2020-05'), instant('2020-05-31T23:59:59Z'))).toBe(
      'Jane Smith'
    )
    expect(HumanName.displayName(endingIn('2020-05'), instant('2020-06-01T00:00:00Z'))).toBe(
      'Jane Doe'
    )
    expect(HumanName.displayName(endingIn('2020'), instant('2020-12-31T23:59:59Z'))).toBe(
      'Jane Smith'
    )
    expect(HumanName.displayName(endingIn('2020'), instant('2021-01-01T00:00:00Z'))).toBe(
      'Jane Doe'
    )
  })

  it('should end a name with a full dateTime end at that instant', () => {
    // Arrange
    const names = [
      {
        use: 'official',
        family: 'Smith',
        given: ['Jane'],
        period: { end: '2024-06-01T12:00:00Z' },
      },
      { use: 'usual', family: 'Doe', given: ['Jane'] },
    ]

    // Act / Assert
    expect(HumanName.displayName(names, instant('2024-06-01T12:00:00Z'))).toBe('Jane Smith')
    expect(HumanName.displayName(names, instant('2024-06-01T12:00:01Z'))).toBe('Jane Doe')
  })

  it("should judge a decoded name's period by the same rule", () => {
    // Arrange — the decoded datatype carries `period.end` as a `DateTime`
    const now = instant('2024-06-01T00:00:00Z')
    const names = [
      Schema.decodeUnknownSync(HumanName.Schema)({
        use: 'official',
        family: 'Smith',
        given: ['Jane'],
        period: { end: '2020-01-01T00:00:00Z' },
      }),
      Schema.decodeUnknownSync(HumanName.Schema)({ family: 'Doe', given: ['Jane'] }),
    ]

    // Act / Assert
    expect(HumanName.displayName(names, now)).toBe('Jane Doe')
  })

  it('should still name the person when every name on record is a former one', () => {
    expect(
      HumanName.displayName([
        { use: 'old', given: [' '] },
        { use: 'old', family: 'Smith', given: ['Jane'] },
        { use: 'maiden', family: 'Byron', given: ['Ada'] },
      ])
    ).toBe('Jane Smith')
  })

  it('should never return blank, untrimmed or double-spaced text', () => {
    fc.assert(
      fc.property(namesArb, (names) => {
        // Act
        const name = HumanName.displayName(names, NOW)

        // Assert
        expect(name === null || (name.length > 0 && name === name.trim())).toBe(true)
        expect(name?.includes('  ') ?? false).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should be null exactly when no name renders to anything', () => {
    fc.assert(
      fc.property(namesArb, (names) => {
        // Arrange
        const anyRenders = names.some(
          (name) =>
            [...(name.given ?? []), name.family ?? '', name.text ?? ''].join('').trim().length > 0
        )

        // Act
        const name = HumanName.displayName(names, NOW)

        // Assert
        expect(name === null).toBe(!anyRenders)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always show a current official name over any former name', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ use: fc.constantFrom('old', 'maiden'), given: nonBlankArb })),
        nonBlankArb,
        fc.array(fc.record({ use: fc.constantFrom('old', 'maiden'), given: nonBlankArb })),
        (formerBefore, officialGiven, formerAfter) => {
          // Arrange
          const names = [
            ...formerBefore.map((former) => ({ use: former.use, given: [former.given] })),
            { use: 'official', given: [officialGiven] },
            ...formerAfter.map((former) => ({ use: former.use, given: [former.given] })),
          ]

          // Act
          const name = HumanName.displayName(names, NOW)

          // Assert
          expect(name).toBe(officialGiven.trim())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** `iso` as a `DateTime`, failing the test when it does not parse. */
const instant = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso)

const NOW = instant('2024-06-01T00:00:00Z')

/** A name part, possibly blank or padded, but never double-spaced inside. */
const partArb = fc.string().filter((text) => !text.includes('  '))

/** A name part with at least one non-whitespace character. */
const nonBlankArb = partArb.filter((text) => text.trim().length > 0)

/** Loosely-typed names, the way raw wire JSON carries them. */
const namesArb = fc.array(
  fc.record(
    {
      use: fc.constantFrom('usual', 'official', 'temp', 'nickname', 'anonymous', 'old', 'maiden'),
      given: fc.array(partArb),
      family: partArb,
      text: partArb,
      period: fc.record(
        { end: fc.constantFrom('2020-01-01', '2024-06', '2030', 'not a date') },
        { requiredKeys: [] }
      ),
    },
    { requiredKeys: [] }
  )
)
