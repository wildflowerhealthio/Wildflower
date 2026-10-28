import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  Observation,
  Patient,
  Practitioner,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type DecodedFile,
  type FileResolution,
  FormatDecode,
  type Link,
  LinkableResource,
  LinkTarget,
  Referent,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { HashMap, Option, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { type Disposition, planWrite, skipReasonFor, type WriteDecision } from './plan-write.ts'
import type { FormatKind } from './registry.ts'
import type { ResolvedBatch } from './resolve-mentions.ts'
import { LINKED_GROUP, type ReviewGroup } from './review-group.ts'

const patient = (id: string, gender: 'male' | 'female' | null = null): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id, gender })

/** A row keyed `key` holding `resource`. */
const row = (key: string, resource: FhirResourceWithId): DecodedFile.Resource => ({
  key,
  title: `${resource.resourceType}/${resource.id}`,
  resource,
})

/** A row keyed `key` holding the Patient of id `key`. */
const patientRow = (key: string): DecodedFile.Resource => row(key, patient(key))

/** An `unreadableFiles` row for one broken pick. */
const unreadableFile = (fileName: string): FormatDecode.UnreadableFile => ({
  id: `har/0:${fileName}`,
  title: fileName,
  pickedFile: { id: `0:${fileName}`, fileName, bytes: new Uint8Array() },
  error: new ParseResult.ParseError({
    issue: new ParseResult.Type(Schema.Never.ast, 'x', 'unreadable'),
  }),
})

/** `kind`'s result of one file and one section holding `resources`. */
const resultOf = <K extends FormatKind>(
  kind: K,
  resources: readonly DecodedFile.Resource[]
): FormatDecode.Result<K> => ({
  ...FormatDecode.emptyResult(kind),
  id: `${kind}/a`,
  title: `${kind} a`,
  files: [{ id: `0:${kind}`, fileName: kind, bytes: new Uint8Array([1]) }],
  decoded: { sections: [{ title: 's', resources }], notes: [] },
})

/** A resolved batch of the given formats' rows, the others claiming nothing, with `linked` its linked records. */
const batchOf = (
  rows: { readonly [K in FormatKind]?: readonly DecodedFile.Resource[] },
  linked: readonly LinkedRecord[] = []
): ResolvedBatch => {
  const slot = <K extends FormatKind>(kind: K): FormatDecode.Result<K> => {
    const resources = rows[kind]
    return resources === undefined ? FormatDecode.emptyResult(kind) : resultOf(kind, resources)
  }
  return {
    formats: { har: slot('har'), 'lifelabs-pdf': slot('lifelabs-pdf'), dicom: slot('dicom') },
    unrecognizedFiles: [],
    linkedRecords: linked.map(({ entry }) => entry),
    linkTargetsByReferentKey: HashMap.fromIterable(
      linked.map(({ link }) => [Referent.key(link.referent), link.target] as const)
    ),
  }
}

/** Each decision as `[group, key, disposition]`, in plan order. */
const dispositionsOf = (
  plan: readonly WriteDecision[]
): readonly (readonly [ReviewGroup, string, Disposition])[] =>
  plan.map(({ group, entry, disposition }) => [group, entry.key, disposition] as const)

/** A selection with `keys` toggled off. */
const excluding = (...keys: readonly string[]): StagedImport.Selection =>
  StagedImport.setResourcesIncluded(StagedImport.initial(), keys, false)

describe('skipReasonFor', () => {
  it('names a format with only unreadable files unreadable', () => {
    expect(
      skipReasonFor({
        ...FormatDecode.emptyResult('har'),
        files: [{ id: '0:broken.har', fileName: 'broken.har', bytes: new Uint8Array() }],
        unreadableFiles: [unreadableFile('broken.har')],
      })
    ).toBe('unreadable')
  })

  it('names a format whose decode yielded resources beside an unreadable file nothing', () => {
    expect(
      skipReasonFor({
        ...resultOf('har', [patientRow('a')]),
        unreadableFiles: [unreadableFile('broken.har')],
      })
    ).toBe('nothing')
  })

  it('names a format that claimed no files nothing', () => {
    expect(skipReasonFor(FormatDecode.emptyResult('har'))).toBe('nothing')
  })
})

describe('planWrite', () => {
  it('includes the kept rows of a format beside its unreadable file, the toggled-off one excluded', () => {
    const batch = batchOf({ har: [patientRow('a'), patientRow('b')] })

    expect(dispositionsOf(planWrite(batch, () => excluding('a'), new Set()))).toEqual([
      ['har', 'a', 'Excluded'],
      ['har', 'b', 'Included'],
    ])
  })

  it('property: every format row is Excluded when toggled off, else Included, in review order, edits substituted', () => {
    const keysArbitrary = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,4}$/u), { maxLength: 6 })
    fc.assert(
      fc.property(
        keysArbitrary,
        fc.func(fc.boolean()),
        fc.func(fc.boolean()),
        (keys, excludes, edits) => {
          let selection = StagedImport.initial()
          for (const key of keys) {
            if (excludes(key)) selection = StagedImport.toggleResource(selection, key)
            if (edits(key)) selection = StagedImport.edit(selection, key, patient(key, 'female'))
          }

          const plan = planWrite(batchOf({ har: keys.map(patientRow) }), () => selection, new Set())

          expect(plan).toEqual(
            keys.map((key): WriteDecision => ({
              group: 'har',
              entry: row(key, edits(key) ? patient(key, 'female') : patient(key)),
              disposition: excludes(key) ? 'Excluded' : 'Included',
            }))
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('submits the linked records first, then each claimed format in registry order', () => {
    const batch = batchOf(
      {
        dicom: [patientRow('d')],
        har: [observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] })],
      },
      [PROVISIONAL]
    )

    expect(dispositionsOf(planWrite(batch, () => StagedImport.initial(), new Set()))).toEqual([
      [LINKED_GROUP, PROVISIONAL.key, 'Included'],
      ['har', 'obs-1', 'Included'],
      ['dicom', 'd', 'Included'],
    ])
  })

  it('includes a new linked record a written resource names, in any reference field', () => {
    const batch = batchOf(
      { har: [observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] })] },
      [PROVISIONAL]
    )

    expect(dispositionsOf(planWrite(batch, () => StagedImport.initial(), new Set()))).toEqual([
      [LINKED_GROUP, PROVISIONAL.key, 'Included'],
      ['har', 'obs-1', 'Included'],
    ])
  })

  it('leaves the provisional Practitioner unreferenced once the only resource naming it is excluded', () => {
    const batch = batchOf(
      {
        har: [
          observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] }),
          observationOf('obs-2', {}),
        ],
      },
      [PROVISIONAL]
    )

    expect(dispositionsOf(planWrite(batch, () => excluding('obs-1'), new Set()))).toEqual([
      [LINKED_GROUP, PROVISIONAL.key, 'Unreferenced'],
      ['har', 'obs-1', 'Excluded'],
      ['har', 'obs-2', 'Included'],
    ])
  })

  it('still includes a changed stored copy once the only resource naming it is excluded', () => {
    const batch = batchOf(
      { har: [observationOf('obs-1', { subject: { reference: STORED_PATIENT } })] },
      [STORED]
    )

    expect(dispositionsOf(planWrite(batch, () => excluding('obs-1'), new Set()))).toEqual([
      [LINKED_GROUP, STORED.key, 'Included'],
      ['har', 'obs-1', 'Excluded'],
    ])
  })

  it('leaves out a stored copy the server holds unchanged, even while a resource naming it is written', () => {
    const batch = batchOf(
      { har: [observationOf('obs-1', { subject: { reference: STORED_PATIENT } })] },
      [STORED]
    )

    expect(
      dispositionsOf(planWrite(batch, () => StagedImport.initial(), new Set([STORED.key])))
    ).toEqual([
      [LINKED_GROUP, STORED.key, 'Unchanged'],
      ['har', 'obs-1', 'Included'],
    ])
  })

  it('includes nothing on a re-import whose rows and linked record the server holds unchanged', () => {
    const batch = batchOf(
      { har: [observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] })] },
      [PROVISIONAL]
    )

    expect(
      dispositionsOf(planWrite(batch, () => excluding('obs-1'), new Set([PROVISIONAL.key])))
    ).toEqual([
      [LINKED_GROUP, PROVISIONAL.key, 'Unchanged'],
      ['har', 'obs-1', 'Excluded'],
    ])
  })

  it('leaves out an unchanged new linked record while a resource naming it is written', () => {
    const batch = batchOf(
      { har: [observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] })] },
      [PROVISIONAL]
    )

    expect(
      dispositionsOf(planWrite(batch, () => StagedImport.initial(), new Set([PROVISIONAL.key])))
    ).toEqual([
      [LINKED_GROUP, PROVISIONAL.key, 'Unchanged'],
      ['har', 'obs-1', 'Included'],
    ])
  })

  it('includes the later of two rows under one Type/id, with its own edit, and supersedes the earlier', () => {
    const batch = batchOf({
      har: [row('a', patient('p'))],
      'lifelabs-pdf': [row('b', patient('p'))],
    })
    const edited = patient('p', 'female')
    const selectionFor = (format: FormatKind): StagedImport.Selection =>
      format === 'lifelabs-pdf'
        ? StagedImport.edit(StagedImport.initial(), 'b', edited)
        : StagedImport.initial()

    const plan = planWrite(batch, selectionFor, new Set())

    expect(plan).toEqual([
      { group: 'har', entry: row('a', patient('p')), disposition: 'Superseded' },
      { group: 'lifelabs-pdf', entry: row('b', edited), disposition: 'Included' },
    ])
  })

  it('includes the earlier of two rows under one Type/id once the later is excluded', () => {
    const batch = batchOf({
      har: [row('a', patient('p'))],
      'lifelabs-pdf': [row('b', patient('p'))],
    })
    const selectionFor = (format: FormatKind): StagedImport.Selection =>
      format === 'lifelabs-pdf' ? excluding('b') : StagedImport.initial()

    expect(dispositionsOf(planWrite(batch, selectionFor, new Set()))).toEqual([
      ['har', 'a', 'Included'],
      ['lifelabs-pdf', 'b', 'Excluded'],
    ])
  })

  it('property: one row is Included per distinct Type/id among the candidates, the last of them in submit order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('p-1', 'p-2', 'p-3'), { maxLength: 6 }),
        fc.func(fc.boolean()),
        fc.boolean(),
        (ids, excludes, unchanged) => {
          const rows = ids.map((id, index) => row(`k-${index}`, patient(id)))
          let selection = StagedImport.initial()
          for (const { key } of rows) {
            if (excludes(key)) selection = StagedImport.toggleResource(selection, key)
          }

          const plan = planWrite(
            batchOf({ har: rows }, [STORED]),
            () => selection,
            new Set(unchanged ? [STORED.key] : [])
          )

          const candidates = plan.filter(
            ({ disposition }) => disposition === 'Included' || disposition === 'Superseded'
          )
          const literalReferenceOf = ({ entry }: WriteDecision): string =>
            `${entry.resource.resourceType}/${entry.resource.id}`
          const included = plan.filter(({ disposition }) => disposition === 'Included')
          expect(included.length).toBe(new Set(candidates.map(literalReferenceOf)).size)
          expect(
            candidates.map((decision, index) =>
              candidates
                .slice(index + 1)
                .some((later) => literalReferenceOf(later) === literalReferenceOf(decision))
                ? 'Superseded'
                : 'Included'
            )
          ).toEqual(candidates.map(({ disposition }) => disposition))
          expect(candidates.map(({ entry }) => entry.key)).toEqual([
            ...(unchanged ? [] : [STORED.key]),
            ...rows.filter(({ key }) => !excludes(key)).map(({ key }) => key),
          ])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: a new linked record is included only beside an included resource naming it, a stored copy whenever the server holds it changed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(PROVISIONAL, STORED),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
        fc.func(fc.boolean()),
        fc.boolean(),
        (linkedRecord, namesLinked, excludes, unchanged) => {
          const observations = namesLinked.map((names, index) =>
            observationOf(
              `obs-${index}`,
              names ? { performer: [{ reference: linkedRecord.literalReference }] } : {}
            )
          )
          let selection = StagedImport.initial()
          for (const { key } of observations) {
            if (excludes(key)) selection = StagedImport.toggleResource(selection, key)
          }

          const plan = planWrite(
            batchOf({ har: observations }, [linkedRecord]),
            () => selection,
            new Set(unchanged ? [linkedRecord.key] : [])
          )

          const namedAndIncluded = observations.some(
            ({ key }, index) => namesLinked[index] && !excludes(key)
          )
          const expected = (): Disposition => {
            if (unchanged) return 'Unchanged'
            return linkedRecord === STORED || namedAndIncluded ? 'Included' : 'Unreferenced'
          }
          expect(plan[0]).toEqual({
            group: LINKED_GROUP,
            entry: linkedRecord.entry,
            disposition: expected(),
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

/** The literal reference of the provisional Practitioner a printed name makes. */
const PRACTITIONER = 'Practitioner/provisional-1'

/** The literal reference of the stored Patient a mention is linked to. */
const STORED_PATIENT = 'Patient/s-1'

/** A linked record of a batch: its review entry and the link that lands on it. */
interface LinkedRecord {
  readonly key: string
  readonly literalReference: string
  readonly entry: FileResolution.LinkedRecord
  readonly link: Link.Type
}

/** `linkedResource` as a linked record titled `title`, the link landing on it made by `target`. */
const linkedRecordOf = (
  linkedResource: LinkableResource.WithId,
  title: string,
  target: (linkedTo: LinkableResource.WithId) => LinkTarget.StoredType | LinkTarget.ProvisionalType
): LinkedRecord => {
  const literalReference = LinkableResource.literalReferenceOf(linkedResource)
  const key = `linked:${literalReference}`
  const linkTarget = target(linkedResource)
  return {
    key,
    literalReference,
    entry: { key, title, resource: linkedResource, origin: linkTarget._tag },
    link: {
      referent: {
        _tag: 'ByMentionOnly',
        logicalReference: Option.getOrThrow(
          LinkableResource.tryIntoLogicalReference(linkedResource)
        ),
        label: title,
      } satisfies Referent.ByMentionOnly,
      target: linkTarget,
    },
  }
}

/** A new linked record: the Practitioner made from a printed name, provisional. */
const PROVISIONAL = linkedRecordOf(
  Schema.decodeUnknownSync(withMandatoryId(Practitioner.Schema))({
    resourceType: 'Practitioner',
    id: 'provisional-1',
    identifier: [{ system: 'https://source.example/practitioner-name', value: 'Dr. Provisional' }],
  }),
  'Dr. Provisional',
  (provisional) => LinkTarget.Provisional({ resource: provisional })
)

/** A stored copy: the stored Patient a mention is linked to, the batch's identifiers assumed. */
const STORED = linkedRecordOf(
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id: 's-1',
    identifier: [{ system: 'https://source.example/patient-id', value: 'mrn-1' }],
  }),
  'Stored Patient',
  (stored) => LinkTarget.Stored({ resource: stored })
)

/** An Observation keyed `key` carrying the given reference fields. */
const observationOf = (key: string, references: object): DecodedFile.Resource => ({
  key,
  title: `Observation/${key}`,
  resource: Schema.decodeUnknownSync(withMandatoryId(Observation.Schema))({
    resourceType: 'Observation',
    id: key,
    status: 'final',
    code: { text: 'Heart rate' },
    ...references,
  }),
})
