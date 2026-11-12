import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { Patient, Practitioner } from '../resources/index.ts'
import { MatchGrade } from './index.ts'

describe('MatchGrade.patientGradeOf', () => {
  it.each([
    {
      rule: 'family, every given and birth date equal is probable',
      stored: patient([{ family: 'Brown', given: ['Ann', 'Marie'] }], '1980-02-03'),
      grade: Option.some('probable'),
    },
    {
      rule: 'family and birth date equal with other givens is possible',
      stored: patient([{ family: 'Brown', given: ['Beth'] }], '1980-02-03'),
      grade: Option.some('possible'),
    },
    {
      rule: 'a family that only starts with the query family, sharing no given, is no match',
      stored: patient([{ family: 'Browning', given: ['Beth'] }], '1980-02-03'),
      grade: Option.none(),
    },
    {
      rule: 'another family sharing a given name and the birth date is possible',
      stored: patient([{ family: 'Smith', given: ['Beth', 'Ann'] }], '1980-02-03'),
      grade: Option.some('possible'),
    },
    {
      rule: 'a text name written family first is read so',
      stored: patient([{ text: 'Brown, Ann Marie' }], '1980-02-03'),
      grade: Option.some('probable'),
    },
    {
      rule: 'another birth date is no match',
      stored: patient([{ family: 'Brown', given: ['Ann'] }], '1980-02-04'),
      grade: Option.none(),
    },
    {
      rule: 'no stored birth date is no match',
      stored: patient([{ family: 'Brown', given: ['Ann'] }], null),
      grade: Option.none(),
    },
    {
      rule: 'case, accents and whitespace are ignored',
      stored: patient([{ family: '  BRÖWN ', given: ['  ánn  '] }], '1980-02-03'),
      grade: Option.some('probable'),
    },
    {
      rule: 'a doctor title leading the given names is ignored',
      stored: patient([{ given: ['Dr.', 'Ann'], family: 'Brown' }], '1980-02-03'),
      grade: Option.some('probable'),
    },
    {
      rule: 'any stored name may match',
      stored: patient(
        [
          { family: 'Smith', given: ['Ann'] },
          { family: 'Brown', given: ['Ann'] },
        ],
        '1980-02-03'
      ),
      grade: Option.some('probable'),
    },
  ])('$rule', ({ stored, grade }) => {
    const query = patient([{ family: 'Brown', given: ['Ann'] }], '1980-02-03')

    expect(MatchGrade.patientGradeOf(query, stored)).toEqual(grade)
  })

  it('should grade a query with a family and no given name possible, not probable', () => {
    const query = patient([{ family: 'Brown' }], '1980-02-03')
    const stored = patient([{ family: 'Brown', given: ['Ann'] }], '1980-02-03')

    expect(MatchGrade.patientGradeOf(query, stored)).toEqual(Option.some('possible'))
  })

  it('should grade nothing for a query with no birth date', () => {
    const query = patient([{ family: 'Brown', given: ['Ann'] }], null)
    const stored = patient([{ family: 'Brown', given: ['Ann'] }], null)

    expect(MatchGrade.patientGradeOf(query, stored)).toEqual(Option.none())
  })

  it('should take the best grade any query name takes', () => {
    const query = patient(
      [
        { family: 'Brown', given: ['Zoe'] },
        { family: 'Brown', given: ['Ann'] },
      ],
      '1980-02-03'
    )
    const stored = patient([{ family: 'Brown', given: ['Ann'] }], '1980-02-03')

    expect(MatchGrade.patientGradeOf(query, stored)).toEqual(Option.some('probable'))
  })
})

describe('MatchGrade.practitionerGradeOf', () => {
  it.each([
    {
      rule: 'family and every given equal is probable',
      query: [{ family: 'Brown', given: ['Jonathan'] }],
      stored: [{ family: 'Brown', given: ['Jonathan', 'Q'] }],
      grade: Option.some('probable'),
    },
    {
      rule: 'family equal and first initials agreeing is possible',
      query: [{ text: 'DR J BROWN' }],
      stored: [{ family: 'Brown', given: ['Jonathan'] }],
      grade: Option.some('possible'),
    },
    {
      rule: 'first initials agree the other way round too',
      query: [{ family: 'Brown', given: ['Jonathan'] }],
      stored: [{ text: 'DR J BROWN' }],
      grade: Option.some('possible'),
    },
    {
      rule: 'family equal with first initials differing is no match',
      query: [{ family: 'Brown', given: ['Jonathan'] }],
      stored: [{ family: 'Brown', given: ['Mary'] }],
      grade: Option.none(),
    },
    {
      rule: 'another family is no match',
      query: [{ family: 'Brown', given: ['Jonathan'] }],
      stored: [{ family: 'Browne', given: ['Jonathan'] }],
      grade: Option.none(),
    },
    {
      rule: 'a "Doctor" title leading the text is ignored',
      query: [{ text: 'Doctor  Jonathan   Brown' }],
      stored: [{ family: 'BROWN', given: ['jonathan'] }],
      grade: Option.some('probable'),
    },
    {
      rule: 'a family with no given name ("Dr. Brown") is possible, not probable',
      query: [{ text: 'Dr. Brown' }],
      stored: [{ family: 'Brown', given: ['Jonathan'] }],
      grade: Option.some('possible'),
    },
    {
      rule: 'a text name written family first, a title leading its given names, is read so',
      query: [{ text: 'Brown, Dr. Jonathan' }],
      stored: [{ family: 'Brown', given: ['Jonathan'] }],
      grade: Option.some('probable'),
    },
    {
      rule: 'another family is no match, even sharing a given name',
      query: [{ family: 'Smith', given: ['Jonathan'] }],
      stored: [{ family: 'Brown', given: ['Jonathan'] }],
      grade: Option.none(),
    },
    {
      rule: 'a "Dr" title leading the family is ignored, as is one in prefix',
      query: [{ family: 'Dr Brown', given: ['Jonathan'] }],
      stored: [{ prefix: ['Dr.'], family: 'Brown', given: ['Jonathan'] }],
      grade: Option.some('probable'),
    },
  ])('$rule', ({ query, stored, grade }) => {
    expect(MatchGrade.practitionerGradeOf(practitioner(query), practitioner(stored))).toEqual(grade)
  })
})

describe('MatchGrade.comparableNamesOf', () => {
  it('should read a text-only name as given names then a family, and drop a name with no family', () => {
    const { name } = practitioner([{ text: ' Dr. Ann  Marie Brown ' }, { given: ['Solo'] }, {}])

    expect(MatchGrade.comparableNamesOf(name)).toEqual([
      { family: 'brown', given: ['ann', 'marie'] },
    ])
  })

  it.each([
    {
      form: 'one comma: family first',
      text: 'Schmitt, John Jacob',
      name: { family: 'schmitt', given: ['john', 'jacob'] },
    },
    {
      form: 'one comma, a title leading the given names: family first, the title dropped',
      text: 'Schmitt, Dr. John',
      name: { family: 'schmitt', given: ['john'] },
    },
    {
      form: 'one comma before a credential: the credential dropped, given names then family',
      text: 'John Schmitt, MD',
      name: { family: 'schmitt', given: ['john'] },
    },
    {
      form: 'one comma before a dotted credential: the credential dropped',
      text: 'Schmitt, M.D.',
      name: { family: 'schmitt', given: [] },
    },
    {
      form: 'two commas, the last before a credential: the credential dropped, family first',
      text: 'Schmitt, John, RPh',
      name: { family: 'schmitt', given: ['john'] },
    },
    {
      form: 'two commas, the last before a generational suffix: the suffix dropped, family first',
      text: 'Schmitt, John, Jr',
      name: { family: 'schmitt', given: ['john'] },
    },
    {
      form: 'one comma and a generational suffix trailing the given names: the suffix dropped, family first',
      text: 'Schmitt, John Jr.',
      name: { family: 'schmitt', given: ['john'] },
    },
    {
      form: 'a trailing comma: the empty part dropped, given names then family',
      text: 'John Smith,',
      name: { family: 'smith', given: ['john'] },
    },
    {
      form: 'two credentials after commas: both dropped, given names then family',
      text: 'John Smith, MD, PhD',
      name: { family: 'smith', given: ['john'] },
    },
    {
      form: 'no comma and a trailing generational suffix: the suffix dropped',
      text: 'John Smith Jr',
      name: { family: 'smith', given: ['john'] },
    },
    {
      form: 'three commas: given names then family, the commas read as spaces',
      text: 'Schmitt, John, Jacob, MD',
      name: { family: 'jacob', given: ['schmitt', 'john'] },
    },
  ])('should read a text-only name with $form', ({ text, name }) => {
    const { name: names } = practitioner([{ text }])

    expect(MatchGrade.comparableNamesOf(names)).toEqual([name])
  })
})

// Helpers

const patient = (name: readonly object[], birthDate: string | null): Patient.Type =>
  Schema.decodeUnknownSync(Patient.Schema)({
    resourceType: 'Patient',
    name,
    ...(birthDate === null ? {} : { birthDate }),
  })

const practitioner = (name: readonly object[]): Practitioner.Type =>
  Schema.decodeUnknownSync(Practitioner.Schema)({ resourceType: 'Practitioner', name })
