import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as FieldValueText from './field-value-text.ts'
import { storedOf, tyraWire } from './plan.test-helpers.ts'

const NOW = DateTime.unsafeMake('2026-11-27T12:00:00Z')

/** The text `value` of `field` is shown as. */
const shown = (field: string, value: unknown): string =>
  FieldValueText.textOfValue(NOW, field, value).text

describe('FieldValueText.textOfValue', () => {
  it('says each name as shown, with its use when it states one', () => {
    const names = [
      { family: 'Ashford', given: ['Tyra'], use: 'maiden' },
      { family: 'Banks', given: ['Tyra'] },
    ]

    expect(shown('name', names)).toBe('Tyra Ashford (maiden); Tyra Banks')
  })

  it('says each address as its text, else its lines, city, state, postal code and country, with its use', () => {
    const addresses = [
      { text: '1 Main St, Toronto', use: 'home' },
      { line: ['2 King St', 'Unit 4'], city: 'Ottawa', state: 'ON', postalCode: 'K1A 0A6' },
    ]

    expect(shown('address', addresses)).toBe(
      '1 Main St, Toronto (home); 2 King St, Unit 4, Ottawa, ON, K1A 0A6'
    )
  })

  it('says contact points by system, value and use, and identifiers by value', () => {
    expect([
      shown('telecom', [
        { system: 'phone', value: '416-555-0100', use: 'home' },
        { system: 'email', value: 'tyra@example.org' },
      ]),
      shown('identifier', [{ system: 'https://a.example/Patient', value: 'pat-7' }]),
    ]).toEqual(['phone 416-555-0100 (home), email tyra@example.org', 'pat-7'])
  })

  it('says the common FHIR shapes by what they say', () => {
    expect([
      shown('text', {
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">…</div>',
      }),
      shown('maritalStatus', { coding: [{ code: 'M', display: 'Married' }], text: 'Married' }),
      shown('maritalStatus', { coding: [{ code: 'M', display: 'Married' }] }),
      shown('maritalStatus', { coding: [{ system: 'https://codes.example', code: 'M' }] }),
      shown('managingOrganization', { reference: 'Organization/o-1', display: 'Rexall' }),
      shown('managingOrganization', { reference: 'Organization/o-1' }),
      shown('generalPractitioner', [
        { identifier: { system: 'https://a.example', value: 'pr-9' } },
        { display: 'Dr. Brown' },
      ]),
      shown('effectivePeriod', { start: '2026-01-02', end: '2026-02-03' }),
      shown('valueQuantity', { value: 72.5, unit: 'kg' }),
      shown('extension', [{ url: 'https://a.example/x' }, { url: 'https://a.example/y' }]),
      shown('extension', [{ url: 'https://a.example/x' }]),
    ]).toEqual([
      'Narrative',
      'Married',
      'Married',
      'M',
      'Rexall',
      'Organization/o-1',
      'pr-9, Dr. Brown',
      '2026-01-02 – 2026-02-03',
      '72.5 kg',
      '2 extensions',
      '1 extension',
    ])
  })

  it('says a value that does not read as its field type as compact JSON', () => {
    expect(FieldValueText.textOfValue(NOW, 'telecom', { value: 7 })).toEqual({
      text: '{"value":7}',
      whole: Option.none(),
    })
  })

  it('says a string, number or boolean of any other field as itself', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.double({ noNaN: true }), fc.boolean()), (value) => {
        expect(shown('birthDate', value)).toBe(String(value))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('says a value of no common shape as compact JSON, cut short past 80 characters with the whole kept', () => {
    // Keys that are no common shape's own.
    const arbitraryUnshaped = fc.dictionary(
      fc.string().map((key) => `k${key}`),
      fc.jsonValue(),
      { minKeys: 1 }
    )
    fc.assert(
      fc.property(arbitraryUnshaped, (value) => {
        const json = JSON.stringify(value)
        expect(FieldValueText.textOfValue(NOW, 'contact', value)).toEqual(
          json.length <= 80
            ? { text: json, whole: Option.none() }
            : { text: `${json.slice(0, 79)}…`, whole: Option.some(json) }
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('FieldValueText.textOf', () => {
  it("says a resource's value of a field, and nothing for a field it has no value for", () => {
    const patient = storedOf({ ...tyraWire(), id: 's-1', telecom: [] })

    expect([
      FieldValueText.textOf(NOW, patient, 'birthDate'),
      FieldValueText.textOf(NOW, patient, 'gender'),
      FieldValueText.textOf(NOW, patient, 'telecom'),
    ]).toEqual([
      Option.some({ text: '1990-01-02', whole: Option.none() }),
      Option.none(),
      Option.none(),
    ])
  })
})

describe('FieldValueText.differenceTextsOf', () => {
  it('says each side as text when they read apart', () => {
    const kept = storedOf({
      ...tyraWire({ telecom: [{ system: 'phone', value: '555-0100' }] }),
      id: 's-1',
    })
    const incoming = storedOf({
      ...tyraWire({ telecom: [{ system: 'phone', value: '555-0199' }] }),
      id: 's-2',
    })

    expect(FieldValueText.differenceTextsOf(NOW, 'telecom', kept, incoming)).toEqual({
      kept: Option.some({ text: 'phone 555-0100', whole: Option.none() }),
      incoming: Option.some({ text: 'phone 555-0199', whole: Option.none() }),
    })
  })

  it('says each side as its JSON when two different values read alike', () => {
    // The same identifier value under two systems: shown by value alone, they read alike.
    const kept = storedOf({
      ...tyraWire({ identifier: [{ system: 'https://a.example/Patient', value: 'pat-7' }] }),
      id: 's-1',
    })
    const incoming = storedOf({
      ...tyraWire({ identifier: [{ system: 'https://b.example/Patient', value: 'pat-7' }] }),
      id: 's-2',
    })

    expect(FieldValueText.readAlike(NOW, 'identifier', kept, incoming)).toBe(true)
    expect(FieldValueText.differenceTextsOf(NOW, 'identifier', kept, incoming)).toEqual({
      kept: FieldValueText.jsonOf(kept, 'identifier'),
      incoming: FieldValueText.jsonOf(incoming, 'identifier'),
    })
    expect(
      Option.map(FieldValueText.jsonOf(kept, 'identifier'), ({ text }) =>
        text.includes('https://a.example/Patient')
      )
    ).toEqual(Option.some(true))
  })
})

describe('FieldValueText.isMonospaced', () => {
  it('sets identifiers in mono, and nothing else', () => {
    expect(['identifier', 'name', 'birthDate'].map(FieldValueText.isMonospaced)).toEqual([
      true,
      false,
      false,
    ])
  })
})
