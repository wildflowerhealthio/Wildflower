import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { MatchQuery } from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Equal, HashMap, Option, Order } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as ImportedCopy from '../entities/imported-copy.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import type * as RecordKey from '../entities/record-key.ts'
import * as RecordReferences from '../entities/record-references.ts'
import {
  copyOf,
  detached,
  drBrownWire,
  NAMES,
  OTHER_SOURCE,
  prescriptionWire,
  SOURCE,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import { locateReferences } from './locate-references.ts'

const prescription = copyOf(
  detached(prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' })),
  'rx-1'
)
const drBrown = copyOf(detached(drBrownWire), 'rx-1#implied', 'a.har', { isImplied: true })

const HCN = 'https://health-card.example/hcn'
const hcn = { system: HCN, value: '3648223849' }

/** Tyra's Patient as `fileName` holds her under `reviewKey`, carrying `identifier`. */
const tyraCarrying = (
  identifier: readonly object[],
  reviewKey: string,
  fileName: string,
  fields: object = {}
): ImportedCopy.Type =>
  copyOf(detached(tyraWire('tyra', { identifier, ...fields })), reviewKey, fileName)

/** The lab file's Observation, its `subject` Tyra by her health card number alone. */
const labObservation = copyOf(
  detached({
    resourceType: 'Observation',
    identifier: [{ system: SOURCE, value: 'a1c-1' }],
    status: 'final',
    code: { text: 'A1c' },
    subject: { type: 'Patient', identifier: hcn, display: 'Tyra Ashford' },
  }),
  'a1c-1',
  'lab.pdf'
)

/** The EHR file's Tyra: keyed in the source's system, carrying her health card number too. */
const ehrTyra = tyraCarrying([{ system: SOURCE, value: 'tyra' }, hcn], 'tyra', 'ehr.har')

/** What `copies` reference: the review keys of the referenced records' first copies, and how many references are external. */
const referencesOf = (
  copies: readonly ImportedCopy.Type[]
): { readonly referenced: readonly string[]; readonly external: number } => {
  const records = ImportedRecord.fromCopies(copies)
  const references = locateReferences(records)
  return {
    referenced: records
      .filter(({ key }) => RecordReferences.isReferenced(references, key))
      .map(({ copies: [first] }) => first.reviewKey),
    external: references.external.length,
  }
}

describe('locateReferences', () => {
  it('should find the records another record references and the references that name no record', () => {
    // Arrange
    const records = ImportedRecord.fromCopies([prescription, drBrown])
    const tyraReference = LogicalReference.make(
      'Patient',
      Option.getOrThrow(DetachedResource.keyIdentifierOf(detached(tyraWire('tyra'))))
    )

    // Act
    const references = locateReferences(records)

    // Assert
    expect({
      referenced: [...HashMap.keys(references.referrers)],
      external: references.external.map(LogicalReference.key),
    }).toEqual({
      referenced: [ImportedCopy.recordKeyOf(drBrown)],
      external: [LogicalReference.key(tyraReference)],
    })
  })

  it('should find a record referenced by an identifier other than its key', () => {
    // Arrange
    const brownByLicence = copyOf(
      detached({
        ...drBrownWire,
        identifier: [...drBrownWire.identifier, { system: SOURCE, value: 'licence-7' }],
      }),
      'brown'
    )
    const byLicence = copyOf(
      detached(prescriptionWire('rx-2', { system: SOURCE, value: 'licence-7' })),
      'rx-2'
    )

    // Act
    const references = locateReferences(ImportedRecord.fromCopies([byLicence, brownByLicence]))

    // Assert
    expect([...HashMap.keys(references.referrers)]).toEqual([
      ImportedCopy.recordKeyOf(brownByLicence),
    ])
  })

  it('should name the record keyed by a reference’s identifier when another decoded record carries it too', () => {
    // Arrange
    const labTyra = tyraCarrying([hcn], 'patient', 'lab.pdf')

    // Act
    const references = referencesOf([ehrTyra, labTyra, labObservation])

    // Assert
    expect(references).toEqual({ referenced: ['lab.pdf/patient'], external: 0 })
  })

  it('should name the decoded record carrying a reference’s identifier over the record the reference implied', () => {
    // Arrange
    const impliedTyra = copyOf(
      detached({ resourceType: 'Patient', identifier: [hcn], name: [{ text: 'Tyra Ashford' }] }),
      'a1c-1#implied',
      'lab.pdf',
      { isImplied: true }
    )

    // Act
    const references = referencesOf([ehrTyra, labObservation, impliedTyra])

    // Assert
    expect(references).toEqual({ referenced: ['ehr.har/tyra'], external: 0 })
  })

  it('should name the record keyed by a reference’s identifier among several decoded records carrying it', () => {
    // Arrange
    const pharmacyTyra = tyraCarrying(
      [{ system: OTHER_SOURCE, value: 'tyra' }, hcn],
      'tyra',
      'pharmacy.har'
    )
    const labTyra = tyraCarrying([hcn], 'patient', 'lab.pdf')

    // Act
    const references = referencesOf([ehrTyra, pharmacyTyra, labTyra, labObservation])

    // Assert
    expect(references).toEqual({ referenced: ['lab.pdf/patient'], external: 0 })
  })

  it('should name none of several decoded records carrying an identifier that is no record’s key, and not count it as external', () => {
    // Arrange
    const pharmacyTyra = tyraCarrying(
      [{ system: OTHER_SOURCE, value: 'tyra' }, hcn],
      'tyra',
      'pharmacy.har'
    )

    // Act
    const references = referencesOf([ehrTyra, pharmacyTyra, labObservation])

    // Assert
    expect(references).toEqual({ referenced: [], external: 0 })
  })

  it('should not count a record as referenced by itself when the rule names it among several', () => {
    // Arrange
    const selfNamingLabTyra = tyraCarrying([hcn], 'patient', 'lab.pdf', {
      link: [{ type: 'seealso', other: { type: 'Patient', identifier: hcn } }],
    })

    // Act
    const references = referencesOf([ehrTyra, selfNamingLabTyra])

    // Assert
    expect(references).toEqual({ referenced: [], external: 0 })
  })

  it('should name each record by every qualified identifier its copies carry, a shared one the record keyed by it', () => {
    // Arrange
    const tyra = copyOf(detached(tyraWire('tyra')), 'tyra')
    const twin = copyOf(
      detached(
        tyraWire('twin', {
          identifier: [
            { system: OTHER_SOURCE, value: 'twin' },
            { system: SOURCE, value: 'tyra' },
          ],
        })
      ),
      'twin'
    )

    // Act
    const references = locateReferences(ImportedRecord.fromCopies([tyra, twin]))

    // Assert
    expect(
      references.named.map(({ logicalReference, key }) => ({
        value: logicalReference.identifier[0].value,
        key,
      }))
    ).toEqual([
      { value: 'tyra', key: ImportedCopy.recordKeyOf(tyra) },
      { value: 'twin', key: ImportedCopy.recordKeyOf(twin) },
    ])
  })

  it('should not count a record naming itself as referenced', () => {
    // Arrange
    const selfNaming = copyOf(
      detached(
        tyraWire('tyra', {
          link: [
            {
              type: 'seealso',
              other: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
            },
          ],
        })
      ),
      'tyra'
    )

    // Act
    const references = locateReferences(ImportedRecord.fromCopies([selfNaming]))

    // Assert
    expect({
      referenced: HashMap.size(references.referrers),
      external: references.external.length,
    }).toEqual({ referenced: 0, external: 0 })
  })
})

/** An Observation keyed by `value`, its `subject` the Patient keyed by `subject` under the source's system. */
const observationAbout = (value: string, subject: object, fileName = 'a.har'): ImportedCopy.Type =>
  copyOf(
    detached({
      resourceType: 'Observation',
      identifier: [{ system: SOURCE, value }],
      status: 'final',
      code: { text: 'A1c' },
      subject: { type: 'Patient', identifier: subject },
    }),
    value,
    fileName
  )

describe('locateReferences, by outcome', () => {
  it('should link a reference in the import, leave an ambiguous one alone, and ask about an external one', () => {
    // Arrange
    const pharmacyTyra = tyraCarrying(
      [{ system: OTHER_SOURCE, value: 'tyra' }, hcn],
      'tyra',
      'pharmacy.har'
    )
    const copies = [
      ehrTyra,
      pharmacyTyra,
      observationAbout('in-import', { system: SOURCE, value: 'tyra' }),
      observationAbout('ambiguous', hcn),
      observationAbout('not-in-import', { system: SOURCE, value: 'someone-else' }),
    ]

    // Act
    const references = locateReferences(ImportedRecord.fromCopies(copies))

    // Assert
    expect({
      referenced: [...HashMap.keys(references.referrers)],
      external: references.external.map(({ identifier: [{ value }] }) => value),
    }).toEqual({ referenced: [ImportedCopy.recordKeyOf(ehrTyra)], external: ['someone-else'] })
  })
})

describe('locateReferences, its rules', () => {
  it('should list each external reference once, in record order of its first holder', () => {
    // Arrange
    const copies = [
      observationAbout('first', { system: SOURCE, value: 'b' }),
      observationAbout('second', { system: SOURCE, value: 'a' }),
      observationAbout('third', { system: SOURCE, value: 'b' }),
    ]

    // Act
    const { external } = locateReferences(ImportedRecord.fromCopies(copies))

    // Assert
    expect(external.map(({ identifier: [{ value }] }) => value)).toEqual(['b', 'a'])
  })

  it('should count a record named by itself and by another record as referenced', () => {
    // Arrange
    const selfNaming = copyOf(
      detached(
        tyraWire('tyra', {
          link: [
            {
              type: 'seealso',
              other: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
            },
          ],
        })
      ),
      'tyra'
    )
    const copies = [selfNaming, observationAbout('a1c-1', { system: SOURCE, value: 'tyra' })]

    // Act
    const references = referencesOf(copies)

    // Assert
    expect(references).toEqual({ referenced: ['a.har/tyra'], external: 0 })
  })

  it('should keep the first-seen value of a reference several records hold', () => {
    // Arrange
    const copies = [
      observationAbout('first', { system: SOURCE, value: 'someone', use: 'official' }),
      observationAbout('second', { system: SOURCE, value: 'someone', use: 'secondary' }),
    ]

    // Act
    const { external } = locateReferences(ImportedRecord.fromCopies(copies))

    // Assert
    expect(external.map(({ identifier: [{ value, use }] }) => ({ value, use }))).toEqual([
      { value: 'someone', use: 'official' },
    ])
  })
})

/** Tyra naming herself by her own key identifier, in a `link`. */
const selfNamingTyra = copyOf(
  detached(
    tyraWire('tyra', {
      link: [
        {
          type: 'seealso',
          other: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
        },
      ],
    })
  ),
  'tyra'
)

/** Each qualified identifier a copy of `record` carries, under its type, as a `LogicalReference.key`. */
const carriedKeysOf = (record: ImportedRecord.Type): ReadonlySet<string> =>
  new Set(
    record.copies.flatMap(({ resource }) =>
      MatchQuery.qualifiedIdentifiersOf(resource).map((identifier) =>
        LogicalReference.key(LogicalReference.make(resource.resourceType, identifier))
      )
    )
  )

/** Each unlinked reference a copy of `record` holds, as a `LogicalReference.key`. */
const heldKeysOf = (record: ImportedRecord.Type): readonly string[] =>
  record.copies.flatMap(({ resource }) =>
    Arr.filterMap(ResourceReferences.collect(resource), ({ reference }) =>
      Option.map(LogicalReference.tryFromReference(reference), LogicalReference.key)
    )
  )

/**
 * Whether `holder` holds an unlinked reference whose identifier, under its
 * type, a copy of `named` carries: what naming a record takes, read without
 * the naming rule.
 */
const holdsReferenceTo = (holder: ImportedRecord.Type, named: ImportedRecord.Type): boolean => {
  const carried = carriedKeysOf(named)
  return heldKeysOf(holder).some((key) => carried.has(key))
}

/**
 * Whether `holder` holds an unlinked reference whose identifier `named`
 * carries and no other of `records` does, so it names `named` whatever the
 * naming rule decides between several carriers.
 */
const holdsUnambiguousReferenceTo = (
  records: readonly ImportedRecord.Type[],
  holder: ImportedRecord.Type,
  named: ImportedRecord.Type
): boolean => {
  const carried = carriedKeysOf(named)
  const carriedByOthers = new Set(
    records
      .filter((record) => !Equal.equals(record.key, named.key))
      .flatMap((record) => [...carriedKeysOf(record)])
  )
  return heldKeysOf(holder).some((key) => carried.has(key) && !carriedByOthers.has(key))
}

/** Copies an import may hold: Tyra naming herself, results, a prescription and the Dr. Brown it implies. */
const REFERRING_COPIES: readonly ImportedCopy.Type[] = [
  selfNamingTyra,
  observationAbout('a1c-1', { system: SOURCE, value: 'tyra' }),
  observationAbout('a1c-1', { system: SOURCE, value: 'tyra' }, 'b.har'),
  observationAbout('a1c-2', { system: SOURCE, value: 'tyra' }, 'b.har'),
  observationAbout('other', { system: SOURCE, value: 'someone-else' }),
  prescription,
  drBrown,
  labObservation,
  ehrTyra,
]

describe('locateReferences, referrers', () => {
  it('should give each record’s referrers in plan order, each once, and never the record itself', () => {
    // Arrange
    const records = ImportedRecord.fromCopies([
      observationAbout('a1c-2', { system: SOURCE, value: 'tyra' }, 'b.har'),
      selfNamingTyra,
      observationAbout('a1c-1', { system: SOURCE, value: 'tyra' }),
      prescription,
      observationAbout('a1c-1', { system: SOURCE, value: 'tyra' }, 'c.har'),
    ])

    // Act
    const references = locateReferences(records)

    // Assert
    expect(records.map(({ key }) => RecordReferences.referrersOf(references, key))).toEqual([
      [],
      [records[0]?.key, records[2]?.key, records[3]?.key],
      [],
      [],
    ])
  })

  it('should make every referrer another record holding a reference that names the record, and a record referenced exactly when it has one', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([...REFERRING_COPIES]), (copies) => {
        // Arrange
        const records = ImportedRecord.fromCopies(copies)
        const planIndexOf = (key: RecordKey.Type): number =>
          records.findIndex((record) => Equal.equals(record.key, key))

        // Act
        const references = locateReferences(records)

        // Assert
        expect(
          records.map((record) => {
            const referrers = RecordReferences.referrersOf(references, record.key)
            const indices = referrers.map(planIndexOf)
            return {
              isReferenced: RecordReferences.isReferenced(references, record.key),
              selfReferring: referrers.some((key) => Equal.equals(key, record.key)),
              indices,
              holdingAReferenceToIt: Arr.filterMap(indices, (index) =>
                Option.fromNullable(records[index])
              ).filter((referrer) => holdsReferenceTo(referrer, record)).length,
            }
          })
        ).toEqual(
          records.map((record) => {
            const indices = RecordReferences.referrersOf(references, record.key).map(planIndexOf)
            return {
              isReferenced: indices.length > 0,
              selfReferring: false,
              indices: Arr.sort(Arr.dedupe(indices), Order.number),
              holdingAReferenceToIt: indices.length,
            }
          })
        )
      })
    )
  })

  it('should make every other record holding a reference that names the record unambiguously one of its referrers', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([...REFERRING_COPIES]), (copies) => {
        // Arrange
        const records = ImportedRecord.fromCopies(copies)

        // Act
        const references = locateReferences(records)

        // Assert
        const missingReferrers = records.map((record) => {
          const referrers = RecordReferences.referrersOf(references, record.key)
          return records
            .filter(
              (holder) =>
                !Equal.equals(holder.key, record.key) &&
                holdsUnambiguousReferenceTo(records, holder, record) &&
                !referrers.some((key) => Equal.equals(key, holder.key))
            )
            .map(({ key }) => key)
        })
        expect(missingReferrers).toEqual(records.map(() => []))
      })
    )
  })
})
