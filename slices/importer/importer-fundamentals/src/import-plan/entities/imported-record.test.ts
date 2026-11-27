import { Array as Arr, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  copyOf,
  detached,
  drBrown,
  OTHER_SOURCE,
  prescription,
  SOURCE,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import * as ImportedRecord from './imported-record.ts'

/**
 * Covers an imported record: the records copies make in plan order, which
 * copy is the record, and the identifiers its resource carries.
 */

/** The single record `copies` make. */
const recordOf = (copies: Parameters<typeof ImportedRecord.fromCopies>[0]): ImportedRecord.Type => {
  const [record] = ImportedRecord.fromCopies(copies)
  if (record === undefined) throw new Error('The copies make no record')
  return record
}

/** Tyra's Patient as one file holds her, its stage id derived as `id`. */
const tyraCopy = (fileName: string, fields: object, id: string): ReturnType<typeof copyOf> =>
  copyOf(detached(tyraWire('tyra', fields)), 'tyra', fileName, {
    stageId: { _tag: 'Derived', id },
  })

describe('ImportedRecord.fromCopies', () => {
  it('should give each record where its first copy is, its copies in plan order', () => {
    // Arrange
    const tyraA = tyraCopy('a.har', {}, 'p')
    const tyraB = tyraCopy('b.pdf', {}, 'p')

    // Act
    const records = ImportedRecord.fromCopies([tyraA, prescription, tyraB, drBrown])

    // Assert
    expect(records.map(({ copies }) => copies.map(({ reviewKey }) => reviewKey))).toEqual([
      ['a.har/tyra', 'b.pdf/tyra'],
      ['a.har/rx-1'],
      ['a.har/rx-1#implied'],
    ])
  })
})

describe('ImportedRecord.fromCopies by source URL', () => {
  /** The copy of a Binary of `contentType` the file `fileName` brings, served at one URL. */
  const binaryCopy = (fileName: string, contentType: string): ReturnType<typeof copyOf> =>
    copyOf(detached({ resourceType: 'Binary', contentType }), 'binary', fileName, {
      sourceUrl: Option.some(new URL('https://fhir.example/r4/Binary/report-1')),
    })

  it('should make two file sets’ copies of one Binary one record with both copies, the last decoded copy the record', () => {
    // Arrange
    const fromFirstCapture = binaryCopy('a.har', 'text/plain')
    const fromSecondCapture = binaryCopy('b.har', 'application/pdf')

    // Act
    const records = ImportedRecord.fromCopies([fromFirstCapture, fromSecondCapture])

    // Assert
    expect(
      records.map((record) => ({
        copies: record.copies.map(({ reviewKey }) => reviewKey),
        resource: ImportedRecord.resourceOf(record),
        stageLiteral: ImportedRecord.stageLiteralOf(record),
        literalReferenceIfDerived: ImportedRecord.literalReferenceIfDerived(record),
      }))
    ).toEqual([
      {
        copies: ['a.har/binary', 'b.har/binary'],
        resource: fromSecondCapture.resource,
        stageLiteral: 'Binary/minted/b.har/binary',
        literalReferenceIfDerived: Option.none(),
      },
    ])
  })
})

describe('ImportedRecord.mergeOrder', () => {
  it('should put decoded records before implied ones, each in plan order, a record with a decoded copy counting as decoded', () => {
    // Arrange
    const tyraAs = (
      value: string,
      isImplied: boolean,
      fileName = 'a.har'
    ): ReturnType<typeof copyOf> =>
      copyOf(detached(tyraWire(value)), value, fileName, { isImplied })
    const records = ImportedRecord.fromCopies([
      tyraAs('implied-1', true),
      tyraAs('decoded-1', false),
      tyraAs('both', true),
      tyraAs('both', false, 'b.pdf'),
      tyraAs('implied-2', true),
      tyraAs('decoded-2', false),
    ])

    // Act
    const inMergeOrder = Arr.sort(records, ImportedRecord.mergeOrder)

    // Assert
    expect(inMergeOrder.map(({ copies: [first] }) => first.reviewKey)).toEqual([
      'a.har/decoded-1',
      'a.har/both',
      'a.har/decoded-2',
      'a.har/implied-1',
      'a.har/implied-2',
    ])
  })
})

describe('ImportedRecord.resourceOf', () => {
  it('should make the last decoded copy the record, an implied copy after it not counting', () => {
    // Arrange
    const record = recordOf([
      tyraCopy('a.har', { gender: 'male' }, 'p'),
      tyraCopy('b.pdf', { gender: 'female' }, 'p'),
      { ...tyraCopy('c.pdf', { gender: 'other' }, 'p'), isImplied: true },
    ])

    // Act
    const resource = ImportedRecord.resourceOf(record)

    // Assert
    expect(resource.resourceType === 'Patient' ? resource.gender : null).toBe('female')
  })

  it('should make the last copy the record when every copy is implied', () => {
    // Arrange
    const record = recordOf([
      { ...tyraCopy('a.har', { gender: 'male' }, 'p'), isImplied: true },
      { ...tyraCopy('b.pdf', { gender: 'female' }, 'p'), isImplied: true },
    ])

    // Act
    const resource = ImportedRecord.resourceOf(record)

    // Assert
    expect(resource.resourceType === 'Patient' ? resource.gender : null).toBe('female')
  })

  it('should carry every qualified identifier of every decoded copy, the record copy’s first', () => {
    // Arrange
    const record = recordOf([
      tyraCopy(
        'a.har',
        {
          identifier: [
            { system: SOURCE, value: 'tyra' },
            { system: OTHER_SOURCE, value: 'tyra-at-other' },
          ],
        },
        'p'
      ),
      tyraCopy('b.pdf', {}, 'p'),
      {
        ...tyraCopy(
          'c.pdf',
          {
            identifier: [
              { system: SOURCE, value: 'tyra' },
              { system: 'https://implied.example/id', value: 'from-a-reference' },
            ],
          },
          'p'
        ),
        isImplied: true,
      },
    ])

    // Act
    const resource = ImportedRecord.resourceOf(record)

    // Assert
    expect(
      resource.resourceType === 'Patient' ? resource.identifier.map(({ value }) => value) : []
    ).toEqual(['tyra', 'tyra-at-other'])
  })
})

describe('ImportedRecord.stageLiteralOf and literalReferenceIfDerived', () => {
  it('should name the record by its record copy’s stage id, and give it as derived only when it is', () => {
    // Arrange
    const derived = recordOf([tyraCopy('a.har', {}, 'p-derived')])
    const minted = recordOf([
      copyOf(detached({ resourceType: 'Binary', contentType: 'text/plain' }), 'binary'),
    ])

    // Act / Assert
    expect({
      derived: [
        ImportedRecord.stageLiteralOf(derived),
        ImportedRecord.literalReferenceIfDerived(derived),
      ],
      minted: [
        ImportedRecord.stageLiteralOf(minted),
        ImportedRecord.literalReferenceIfDerived(minted),
      ],
    }).toEqual({
      derived: ['Patient/p-derived', Option.some('Patient/p-derived')],
      minted: ['Binary/minted/a.har/binary', Option.none()],
    })
  })
})

describe('ImportedRecord, what its record copy says of it', () => {
  it('should read its stage id, title, source URL and whether it is implied off its record copy, and name it under any id', () => {
    // Arrange
    const sourceUrl = new URL('https://source.example/fhir/Patient/tyra')
    const implied = copyOf(detached(tyraWire('tyra')), 'rx-1#implied', 'a.har', {
      isImplied: true,
      title: 'Tyra (implied)',
      stageId: { _tag: 'Derived', id: 'p' },
    })
    const decoded = copyOf(detached(tyraWire('tyra')), 'tyra', 'b.pdf', {
      title: 'Tyra Ashford',
      sourceUrl: Option.some(sourceUrl),
      stageId: { _tag: 'Derived', id: 'p' },
    })
    const record = recordOf([decoded, implied])
    const onlyImplied = recordOf([implied])

    // Act / Assert
    expect({
      stageId: ImportedRecord.stageIdOf(record),
      title: ImportedRecord.titleOf(record),
      sourceUrl: ImportedRecord.sourceUrlOf(record),
      isImplied: [ImportedRecord.isImplied(record), ImportedRecord.isImplied(onlyImplied)],
      under: ImportedRecord.literalReferenceUnder(record, 'p-1'),
    }).toEqual({
      stageId: { _tag: 'Derived', id: 'p' },
      title: 'Tyra Ashford',
      sourceUrl: Option.some(sourceUrl),
      isImplied: [false, true],
      under: 'Patient/p-1',
    })
  })
})

describe('ImportedRecord.originOf', () => {
  it('should list a record under the file set of its last decoded copy, else of its last copy when every copy is implied', () => {
    // Arrange
    const impliedIn = (fileName: string): ReturnType<typeof copyOf> =>
      copyOf(detached(tyraWire('tyra')), 'rx-1#implied', fileName, { isImplied: true })
    const fromA = copyOf(detached(tyraWire('tyra')), 'tyra', 'a.har')
    const fromB = copyOf(detached(tyraWire('tyra')), 'tyra', 'b.pdf')

    // Act
    const origins = {
      decoded: ImportedRecord.originOf(recordOf([fromA, fromB, impliedIn('c.har')])),
      implied: ImportedRecord.originOf(recordOf([impliedIn('c.har'), impliedIn('d.har')])),
    }

    // Assert
    expect(origins).toEqual({ decoded: fromB.origin, implied: impliedIn('d.har').origin })
  })
})
