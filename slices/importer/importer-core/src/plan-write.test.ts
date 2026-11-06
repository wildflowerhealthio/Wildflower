import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  Observation,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  FormatDecode,
  LinkableResource,
  LinkPlan,
  LinkTarget,
  type Row,
  Section,
  SectionedList,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { type Disposition, planWrite, skipReasonFor, type WriteDecision } from './plan-write.ts'
import type { FormatKind } from './registry.ts'
import type { ResolvedBatch } from './resolve-mentions.ts'
import { LINKED_GROUP, type ReviewGroup } from './review-group.ts'

const patient = (id: string, gender: 'male' | 'female' | null = null): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id, gender })

/** A row keyed `key` holding `resource`, from `origin`. */
const row = (
  key: string,
  resource: FhirResourceWithId,
  origin: Row.Origin = 'Decoded'
): Row.Type<FhirResourceWithId> => ({
  key,
  title: `${resource.resourceType}/${resource.id}`,
  resource,
  origin,
})

/** A row keyed `key` holding the Patient of id `key`. */
const patientRow = (key: string): Row.Type<FhirResourceWithId> => row(key, patient(key))

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
  resources: readonly Row.Type<FhirResourceWithId>[]
): FormatDecode.Result<K> => ({
  ...FormatDecode.emptyResult(kind),
  id: `${kind}/a`,
  title: `${kind} a`,
  files: [{ id: `0:${kind}`, fileName: kind, bytes: new Uint8Array([1]) }],
  decoded: { rows: SectionedList.make([Section.make('s', resources)]), notes: [] },
})

/** A resolved batch of the given formats' rows, the others claiming nothing, with `linked` its linked records. */
const batchOf = (
  rows: { readonly [K in FormatKind]?: readonly Row.Type<FhirResourceWithId>[] },
  linked: readonly LinkedRecord[] = []
): ResolvedBatch => {
  const slot = <K extends FormatKind>(kind: K): FormatDecode.Result<K> => {
    const resources = rows[kind]
    return resources === undefined ? FormatDecode.emptyResult(kind) : resultOf(kind, resources)
  }
  const formats = { har: slot('har'), 'lifelabs-pdf': slot('lifelabs-pdf'), dicom: slot('dicom') }
  return {
    formats,
    unrecognizedFiles: [],
    linkedRecords: linked.map(({ entry }) => entry),
    plan: LinkPlan.empty,
    decodedBatch: { formats, unrecognizedFiles: [] },
  }
}

/** Each decision as `[group, key, disposition]`, in plan order. */
const dispositionsOf = (
  plan: readonly WriteDecision[]
): readonly (readonly [ReviewGroup, string, Disposition])[] =>
  plan.map(({ group, entry, disposition }) => [group, entry.key, disposition] as const)

/** No row out by default. */
const NONE_BY_DEFAULT: ReadonlySet<string> = new Set()

/** Every format's default: no row out. */
const noneByDefault = (): ReadonlySet<string> => NONE_BY_DEFAULT

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

    expect(
      dispositionsOf(planWrite(batch, () => excluding('a'), noneByDefault, new Set()))
    ).toEqual([
      ['har', 'a', 'Excluded'],
      ['har', 'b', 'Included'],
    ])
  })

  it('excludes a row the default leaves out unless the reviewer ticked it, and a ticked one stands', () => {
    const batch = batchOf({ har: [patientRow('a'), patientRow('b')] })
    const ticked = StagedImport.setResourcesIncluded(StagedImport.initial(), ['b'], true)

    expect(
      dispositionsOf(
        planWrite(
          batch,
          () => ticked,
          () => new Set(['a', 'b']),
          new Set()
        )
      )
    ).toEqual([
      ['har', 'a', 'Excluded'],
      ['har', 'b', 'Included'],
    ])
  })

  it('writes an edit resolved on the plan: a mention link chosen for it moves its mention', () => {
    const asDecoded = observationOf('obs-1', { subject: { reference: 'Patient/elsewhere' } })
    const batch = batchOf({ har: [asDecoded] }, [STORED])
    const withMentionLink: ResolvedBatch = {
      ...batch,
      plan: {
        ...batch.plan,
        mentionLinks: [
          {
            reviewKey: 'obs-1',
            path: 'subject',
            target: LinkTarget.Stored({ resource: STORED_RESOURCE }),
          },
        ],
      },
    }
    const edited = observationOf('obs-1', {
      subject: { reference: 'Patient/elsewhere' },
      code: { text: 'Pulse' },
    }).resource
    const selection = StagedImport.edit(StagedImport.initial(), 'obs-1', edited)

    const written = planWrite(withMentionLink, () => selection, noneByDefault, new Set()).find(
      ({ entry }) => entry.key === 'obs-1'
    )

    expect(written?.entry.resource).toEqual(
      observationOf('obs-1', { subject: { reference: STORED_PATIENT }, code: { text: 'Pulse' } })
        .resource
    )
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
            if (excludes(key))
              selection = StagedImport.toggleResource(selection, NONE_BY_DEFAULT, key)
            if (edits(key)) selection = StagedImport.edit(selection, key, patient(key, 'female'))
          }

          const plan = planWrite(
            batchOf({ har: keys.map(patientRow) }),
            () => selection,
            noneByDefault,
            new Set()
          )

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
        har: [observationOf('obs-1', { subject: { reference: STORED_PATIENT } })],
      },
      [STORED]
    )

    expect(
      dispositionsOf(planWrite(batch, () => StagedImport.initial(), noneByDefault, new Set()))
    ).toEqual([
      [LINKED_GROUP, STORED.key, 'Included'],
      ['har', 'obs-1', 'Included'],
      ['dicom', 'd', 'Included'],
    ])
  })

  it('still includes a changed stored copy once the only resource naming it is excluded', () => {
    const batch = batchOf(
      { har: [observationOf('obs-1', { subject: { reference: STORED_PATIENT } })] },
      [STORED]
    )

    expect(
      dispositionsOf(planWrite(batch, () => excluding('obs-1'), noneByDefault, new Set()))
    ).toEqual([
      [LINKED_GROUP, STORED.key, 'Included'],
      ['har', 'obs-1', 'Excluded'],
    ])
  })

  it('writes a record the import implied only while a written row names it', () => {
    const implied = row('implied-9', patient('implied-9'), 'Implied')
    const batch = batchOf({
      har: [implied, observationOf('obs-1', { subject: { reference: 'Patient/implied-9' } })],
    })

    expect(
      dispositionsOf(planWrite(batch, () => StagedImport.initial(), noneByDefault, new Set()))
    ).toEqual([
      ['har', implied.key, 'Included'],
      ['har', 'obs-1', 'Included'],
    ])
    expect(
      dispositionsOf(planWrite(batch, () => excluding('obs-1'), noneByDefault, new Set()))
    ).toEqual([
      ['har', implied.key, 'Unreferenced'],
      ['har', 'obs-1', 'Excluded'],
    ])
  })

  it('writes a decoded record no written row names', () => {
    const decoded = row('p-9', patient('p-9'))

    expect(
      dispositionsOf(
        planWrite(
          batchOf({ har: [decoded] }),
          () => StagedImport.initial(),
          noneByDefault,
          new Set()
        )
      )
    ).toEqual([['har', 'p-9', 'Included']])
  })

  it('writes the record a file decoded over the copy another file set implied under its id, whatever their order', () => {
    const implied = row('implied-9', patient('p-9'), 'Implied')
    const decoded = row('p-9', patient('p-9', 'female'))
    const naming = observationOf('obs-1', { subject: { reference: 'Patient/p-9' } })

    expect(
      dispositionsOf(
        planWrite(
          batchOf({ har: [decoded, implied, naming] }),
          () => StagedImport.initial(),
          noneByDefault,
          new Set()
        )
      )
    ).toEqual([
      ['har', 'p-9', 'Included'],
      ['har', implied.key, 'Superseded'],
      ['har', 'obs-1', 'Included'],
    ])
  })

  it('writes a decoded record whatever names it', () => {
    const batch = batchOf({
      har: [patientRow('p-1'), observationOf('obs-1', { subject: { reference: 'Patient/p-1' } })],
    })

    expect(
      dispositionsOf(planWrite(batch, () => excluding('obs-1'), noneByDefault, new Set()))
    ).toEqual([
      ['har', 'p-1', 'Included'],
      ['har', 'obs-1', 'Excluded'],
    ])
  })

  it('leaves out a stored copy the server holds unchanged, even while a resource naming it is written', () => {
    const batch = batchOf(
      { har: [observationOf('obs-1', { subject: { reference: STORED_PATIENT } })] },
      [STORED]
    )

    expect(
      dispositionsOf(
        planWrite(batch, () => StagedImport.initial(), noneByDefault, new Set([STORED.key]))
      )
    ).toEqual([
      [LINKED_GROUP, STORED.key, 'Unchanged'],
      ['har', 'obs-1', 'Included'],
    ])
  })

  it('includes nothing on a re-import whose rows and linked record the server holds unchanged', () => {
    const batch = batchOf(
      { har: [observationOf('obs-1', { subject: { reference: STORED_PATIENT } })] },
      [STORED]
    )

    expect(
      dispositionsOf(
        planWrite(batch, () => excluding('obs-1'), noneByDefault, new Set([STORED.key]))
      )
    ).toEqual([
      [LINKED_GROUP, STORED.key, 'Unchanged'],
      ['har', 'obs-1', 'Excluded'],
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

    const plan = planWrite(batch, selectionFor, noneByDefault, new Set())

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

    expect(dispositionsOf(planWrite(batch, selectionFor, noneByDefault, new Set()))).toEqual([
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
            if (excludes(key))
              selection = StagedImport.toggleResource(selection, NONE_BY_DEFAULT, key)
          }

          const plan = planWrite(
            batchOf({ har: rows }, [STORED]),
            () => selection,
            noneByDefault,
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

  it('property: a linked record is included whenever the server holds it changed, whatever the reviewer excluded', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
        fc.func(fc.boolean()),
        fc.boolean(),
        (namesLinked, excludes, unchanged) => {
          const observations = namesLinked.map((names, index) =>
            observationOf(
              `obs-${index}`,
              names ? { subject: { reference: STORED.literalReference } } : {}
            )
          )
          let selection = StagedImport.initial()
          for (const { key } of observations) {
            if (excludes(key))
              selection = StagedImport.toggleResource(selection, NONE_BY_DEFAULT, key)
          }

          const plan = planWrite(
            batchOf({ har: observations }, [STORED]),
            () => selection,
            noneByDefault,
            new Set(unchanged ? [STORED.key] : [])
          )

          expect(plan[0]).toEqual({
            group: LINKED_GROUP,
            entry: STORED.entry,
            disposition: unchanged ? 'Unchanged' : 'Included',
          })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

/** The literal reference of the stored Patient a link targets. */
const STORED_PATIENT = 'Patient/s-1'

/** A linked record of a batch: its review entry. */
interface LinkedRecord {
  readonly key: string
  readonly literalReference: string
  readonly entry: Row.Type<FhirResourceWithId>
}

/** `linkedResource` as a linked record titled `title`. */
const linkedRecordOf = (linkedResource: LinkableResource.WithId, title: string): LinkedRecord => {
  const literalReference = LinkableResource.literalReferenceOf(linkedResource)
  const key = `linked:${literalReference}`
  return {
    key,
    literalReference,
    entry: { key, title, resource: linkedResource, origin: 'Decoded' },
  }
}

/** The system the stored Patient is keyed in. */
const PATIENT_SYSTEM = 'https://source.example/patient-id'

/** The stored Patient a mention is linked to. */
const STORED_RESOURCE = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
  resourceType: 'Patient',
  id: 's-1',
  identifier: [{ system: PATIENT_SYSTEM, value: 'mrn-1' }],
})

/** A stored copy: the stored Patient a mention is linked to, the batch's identifiers assumed. */
const STORED = linkedRecordOf(STORED_RESOURCE, 'Stored Patient')

/** An Observation keyed `key` carrying the given reference fields. */
const observationOf = (key: string, references: object): Row.Type<FhirResourceWithId> => ({
  key,
  title: `Observation/${key}`,
  resource: Schema.decodeUnknownSync(withMandatoryId(Observation.Schema))({
    resourceType: 'Observation',
    id: key,
    status: 'final',
    code: { text: 'Heart rate' },
    ...references,
  }),
  origin: 'Decoded',
})
