import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, DateTime, Option, Schema } from 'effect'
import * as fc from 'fast-check'
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

  it('should keep a decoded name current through the whole day its period ends on', () => {
    // Arrange — a date-only end decodes to the last instant of that day
    const names = [
      Schema.decodeUnknownSync(HumanName.Schema)({
        use: 'official',
        family: 'Smith',
        given: ['Jane'],
        period: { end: '2024-06-01' },
      }),
      Schema.decodeUnknownSync(HumanName.Schema)({ use: 'usual', family: 'Doe', given: ['Jane'] }),
    ]

    // Act / Assert
    expect(HumanName.displayName(names, instant('2024-06-01T12:00:00Z'))).toBe('Jane Smith')
    expect(HumanName.displayName(names, instant('2024-06-02T00:00:00Z'))).toBe('Jane Doe')
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

describe('partsOfText', () => {
  it.each([
    {
      form: 'given names then a family, a leading title in prefix, casing kept',
      text: 'DR J BROWN',
      parts: parts('BROWN', ['J'], { prefix: ['DR'] }),
    },
    {
      form: 'a dotted title leading the text, diacritics kept',
      text: 'Dr. Zoë  Nguyễn',
      parts: parts('Nguyễn', ['Zoë'], { prefix: ['Dr.'] }),
    },
    {
      form: 'a title alone before the family',
      text: 'DR SMITH',
      parts: parts('SMITH', [], { prefix: ['DR'] }),
    },
    {
      form: 'a title after the first word: family before it, given names after it',
      text: 'OSEI DR. KWAME',
      parts: parts('OSEI', ['KWAME'], { prefix: ['DR.'] }),
    },
    {
      form: 'a title after a family of several words',
      text: 'VAN DER BERG DR JAN PIETER',
      parts: parts('VAN DER BERG', ['JAN', 'PIETER'], { prefix: ['DR'] }),
    },
    {
      form: 'a title ending the words of one word: the family, no given names',
      text: 'OSEI DR.',
      parts: parts('OSEI', [], { prefix: ['DR.'] }),
    },
    {
      form: 'a title ending the words: read around the name, not splitting it',
      text: 'John Smith Dr',
      parts: parts('Smith', ['John'], { prefix: ['Dr'] }),
    },
    {
      form: 'a title after a comma: read around the name',
      text: 'John Smith, Dr.',
      parts: parts('Smith', ['John'], { prefix: ['Dr.'] }),
    },
    {
      form: 'one comma, a title trailing the given names: read around the name',
      text: 'Smith, John Dr.',
      parts: parts('Smith', ['John'], { prefix: ['Dr.'] }),
    },
    {
      form: 'a credential ending the words without a comma',
      text: 'DR J BROWN MD',
      parts: parts('BROWN', ['J'], { prefix: ['DR'], suffix: ['MD'] }),
    },
    {
      form: 'a dotted credential ending the words without a comma',
      text: 'John Smith M.D.',
      parts: parts('Smith', ['John'], { suffix: ['M.D.'] }),
    },
    {
      form: 'a title after the first word, a credential ending the words',
      text: 'OSEI DR. KWAME MD',
      parts: parts('OSEI', ['KWAME'], { prefix: ['DR.'], suffix: ['MD'] }),
    },
    {
      form: 'a title after the first word, a credential after a comma',
      text: 'OSEI DR. KWAME, MD',
      parts: parts('OSEI', ['KWAME'], { prefix: ['DR.'], suffix: ['MD'] }),
    },
    {
      form: 'a title after the first word, a generational suffix trailing',
      text: 'OSEI DR. KWAME JR.',
      parts: parts('OSEI', ['KWAME'], { prefix: ['DR.'], suffix: ['JR.'] }),
    },
    {
      form: 'credentials and suffixes after commas and without, in the order written',
      text: 'DR J BROWN JR, MD, PhD',
      parts: parts('BROWN', ['J'], { prefix: ['DR'], suffix: ['JR', 'MD', 'PhD'] }),
    },
    {
      form: 'one comma, a credential and a suffix trailing the given names',
      text: 'Schmitt, John Jr MD',
      parts: parts('Schmitt', ['John'], { suffix: ['Jr', 'MD'] }),
    },
    {
      form: 'a title both leading and after the first word',
      text: 'Dr. Osei Dr. Kwame',
      parts: parts('Osei', ['Kwame'], { prefix: ['Dr.', 'Dr.'] }),
    },
    {
      form: 'one comma: the comma, not a title after it, ends the family',
      text: 'Brown, Dr. Jonathan',
      parts: parts('Brown', ['Jonathan'], { prefix: ['Dr.'] }),
    },
    {
      form: 'one comma, a title leading the family',
      text: 'Dr. Brown, Jonathan',
      parts: parts('Brown', ['Jonathan'], { prefix: ['Dr.'] }),
    },
    {
      form: 'three commas: read as spaces, so a title among the words splits',
      text: 'Roy, Dr., Anne, Marie',
      parts: parts('Roy', ['Anne', 'Marie'], { prefix: ['Dr.'] }),
    },
    {
      form: 'a credential that is also a name: kept as a name',
      text: 'Nguyen, Do',
      parts: parts('Nguyen', ['Do']),
    },
    {
      form: 'dotted initials spelling a title: a given name, not a title',
      text: 'D.R. SMITH',
      parts: parts('SMITH', ['D.R.']),
    },
    {
      form: 'dotted initials spelling a title among the words: no split',
      text: 'Dr. J. D.R. Smith',
      parts: parts('Smith', ['J.', 'D.R.'], { prefix: ['Dr.'] }),
    },
    {
      form: 'a title alone: no family name',
      text: 'Dr.',
      parts: Option.none(),
    },
    {
      form: 'credentials alone: no family name',
      text: 'MD, PhD',
      parts: Option.none(),
    },
    {
      form: 'blank text: no family name',
      text: ' , ',
      parts: Option.none(),
    },
  ])('should read $form', ({ text, parts: expected }) => {
    expect(HumanName.partsOfText(text)).toEqual(expected)
  })

  it('should read given names then a family name as written', () => {
    fc.assert(
      fc.property(fc.array(nameWordArb, { maxLength: 3 }), nameWordArb, (given, family) => {
        expect(HumanName.partsOfText([...given, family].join(' '))).toEqual(parts(family, given))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read a family name before one comma, given names after it, as written', () => {
    fc.assert(
      fc.property(
        fc.array(nameWordArb, { minLength: 1, maxLength: 3 }),
        fc.array(nameWordArb, { minLength: 1, maxLength: 3 }),
        (family, given) => {
          expect(HumanName.partsOfText(`${family.join(' ')}, ${given.join(' ')}`)).toEqual(
            parts(family.join(' '), given)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should split a name at a title among its words, whatever its case and dots', () => {
    fc.assert(
      fc.property(
        fc.array(nameWordArb, { minLength: 1, maxLength: 3 }),
        titleArb,
        fc.array(nameWordArb, { minLength: 1, maxLength: 3 }),
        (family, title, given) => {
          expect(HumanName.partsOfText([...family, title, ...given].join(' '))).toEqual(
            parts(family.join(' '), given, { prefix: [title] })
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read a leading title into prefix and the name as it reads without it', () => {
    fc.assert(
      fc.property(
        titleArb,
        fc.array(nameWordArb, { minLength: 1, maxLength: 4 }),
        (title, words) => {
          expect(HumanName.partsOfText(`${title} ${words.join(' ')}`)).toEqual(
            Option.map(HumanName.partsOfText(words.join(' ')), (read) => ({
              ...read,
              prefix: [title, ...read.prefix],
            }))
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read trailing titles, credentials and suffixes around the name, comma or not', () => {
    fc.assert(
      fc.property(
        fc.array(nameWordArb, { minLength: 1, maxLength: 4 }),
        fc.array(aroundWordArb, { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        (words, trailing, withComma) => {
          // Arrange
          const text = `${words.join(' ')}${withComma ? ',' : ''} ${trailing.map(({ word }) => word).join(' ')}`

          // Act
          const read = HumanName.partsOfText(text)

          // Assert
          expect(read).toEqual(
            Option.map(HumanName.partsOfText(words.join(' ')), (name) => ({
              ...name,
              prefix: trailing.filter(({ isTitle }) => isTitle).map(({ word }) => word),
              suffix: trailing.filter(({ isTitle }) => !isTitle).map(({ word }) => word),
            }))
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('partsOf', () => {
  it('should read the family and given names a name states, a leading title in prefix', () => {
    expect(
      HumanName.partsOf({ family: ' Dr  Van  Berg ', given: ['Ann Marie'], text: 'ignored' })
    ).toEqual(parts('Van Berg', ['Ann', 'Marie'], { prefix: ['Dr'] }))
  })

  it('should read the text of a name that states neither', () => {
    expect(HumanName.partsOf({ given: [], text: 'OSEI DR. KWAME' })).toEqual(
      parts('OSEI', ['KWAME'], { prefix: ['DR.'] })
    )
  })

  it('should read no family name from given names alone', () => {
    expect(HumanName.partsOf({ given: ['Solo'], text: 'Solo Smith' })).toEqual(Option.none())
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

/** A word of a name that is not a title, a credential or a generational suffix, cased any way. */
const nameWordArb = fc
  .stringMatching(/^[A-Za-zÀ-ÿ'-]{1,10}$/u)
  .filter((word) => !HumanName.isTitleCredentialOrSuffix(word))

/** The parts `partsOfText` reads, `prefix` and `suffix` empty unless given. */
const parts = (
  family: string,
  given: readonly string[],
  around: { readonly prefix?: readonly string[]; readonly suffix?: readonly string[] } = {}
): Option.Option<HumanName.Parts> =>
  Option.some({ family, given, prefix: around.prefix ?? [], suffix: around.suffix ?? [] })

/** A doctor's title, cased any way, with or without its dot. */
const titleArb = fc
  .tuple(fc.constantFrom('dr', 'doctor'), fc.boolean(), fc.boolean())
  .map(
    ([title, upperCased, dotted]) =>
      `${upperCased ? title.toUpperCase() : title}${dotted ? '.' : ''}`
  )

/** A word written around a name: a title, or a credential or generational suffix cased any way. */
const aroundWordArb = fc.oneof(
  titleArb.map((word) => ({ word, isTitle: true })),
  fc
    .tuple(
      fc.constantFrom('MD', 'M.D.', 'RPh', 'PharmD', 'PhD', 'Jr', 'Jr.', 'Sr', 'III'),
      fc.boolean()
    )
    .map(([word, upperCased]) => ({ word: upperCased ? word.toUpperCase() : word, isTitle: false }))
)
