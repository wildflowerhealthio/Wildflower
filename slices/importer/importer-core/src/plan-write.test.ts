import {
  type FhirResource,
  Observation,
  Patient,
  Practitioner,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type DecodedFile,
  FormatDecode,
  type Link,
  LinkableResource,
  LinkTarget,
  type Referent,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { planBatchWrite, planFormatWrite } from './plan-write.ts'
import type { ResolvedBatch } from './resolve-mentions.ts'

const resource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

const formatResult = (keys: readonly string[]): FormatDecode.Result<string> => ({
  id: 'u',
  title: 'a.har',
  files: [{ id: '0:a.har', fileName: 'a.har', bytes: new Uint8Array([1]) }],
  format: 'har',
  decoded: {
    sections: [
      {
        title: 's',
        resources: keys.map((key) => ({ key, title: key, resource: resource(key) })),
      },
    ],
    notes: [],
  },
  unreadableFiles: [],
})

/** An `unreadableFiles` row for one broken pick. */
const unreadableFile = (fileName: string): FormatDecode.UnreadableFile => ({
  id: `har/0:${fileName}`,
  title: fileName,
  pickedFile: { id: `0:${fileName}`, fileName, bytes: new Uint8Array() },
  error: new ParseResult.ParseError({
    issue: new ParseResult.Type(Schema.Never.ast, 'x', 'unreadable'),
  }),
})

describe('planFormatWrite', () => {
  it('should skip a format with only unreadable files as unreadable', () => {
    const result: FormatDecode.Result<string> = {
      id: 'u',
      title: 'broken.har',
      files: [{ id: '0:broken.har', fileName: 'broken.har', bytes: new Uint8Array() }],
      format: 'har',
      decoded: { sections: [], notes: [] },
      unreadableFiles: [unreadableFile('broken.har')],
    }
    expect(planFormatWrite(result, StagedImport.initial())).toEqual({
      _tag: 'skip',
      reason: 'unreadable',
    })
  })

  it('should skip as nothing, not unreadable, when the review excluded every resource beside an unreadable file', () => {
    const result: FormatDecode.Result<string> = {
      ...formatResult(['a', 'b']),
      unreadableFiles: [unreadableFile('broken.har')],
    }
    const selection = StagedImport.setResourcesIncluded(StagedImport.initial(), ['a', 'b'], false)
    expect(planFormatWrite(result, selection)).toEqual({ _tag: 'skip', reason: 'nothing' })
  })

  it('should write the kept resources of a format beside its unreadable file', () => {
    const result: FormatDecode.Result<string> = {
      ...formatResult(['a', 'b']),
      unreadableFiles: [unreadableFile('broken.har')],
    }
    const selection = StagedImport.toggleResource(StagedImport.initial(), 'a')
    const plan = planFormatWrite(result, selection)
    if (plan._tag !== 'write') throw new Error('expected a write')
    expect(plan.resources.map((entry) => entry.id)).toEqual(['b'])
    expect(plan.excluded).toBe(1)
  })

  it('should skip a format that claimed no files as nothing', () => {
    expect(planFormatWrite(FormatDecode.emptyResult('har'), StagedImport.initial())).toEqual({
      _tag: 'skip',
      reason: 'nothing',
    })
  })

  it('property: writes exactly the included resources in review order, edits substituted, excluded counted', () => {
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
            if (edits(key)) selection = StagedImport.edit(selection, key, resource(`${key}-edited`))
          }
          const plan = planFormatWrite(formatResult(keys), selection)
          const included = keys.filter((key) => !excludes(key))
          if (included.length === 0) {
            expect(plan).toEqual({ _tag: 'skip', reason: 'nothing' })
            return
          }
          if (plan._tag !== 'write') throw new Error('expected a write')
          expect(plan.resources.map((entry) => entry.id)).toEqual(
            included.map((key) => (edits(key) ? `${key}-edited` : key))
          )
          expect(plan.excluded).toBe(keys.length - included.length)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('planBatchWrite', () => {
  it('writes a new linked record a written resource names, in any reference field', () => {
    const batch = batchWith(
      [observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] })],
      PROVISIONAL
    )

    const plan = planBatchWrite(batch, () => StagedImport.initial(), new Set())

    expect(plan.linked.map(({ key }) => key)).toEqual([PROVISIONAL.key])
    expect(plan.formats.map(({ plan: formatPlan }) => formatPlan._tag)).toEqual(['write'])
  })

  it('drops the provisional Practitioner once the only resource naming it is excluded', () => {
    const batch = batchWith(
      [
        observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] }),
        observationOf('obs-2', {}),
      ],
      PROVISIONAL
    )

    const plan = planBatchWrite(
      batch,
      () => StagedImport.toggleResource(StagedImport.initial(), 'obs-1'),
      new Set()
    )

    expect(plan.linked).toEqual([])
  })

  it('still writes a changed stored copy once the only resource naming it is excluded', () => {
    const batch = batchWith(
      [observationOf('obs-1', { subject: { reference: STORED_PATIENT } })],
      STORED
    )

    const plan = planBatchWrite(
      batch,
      () => StagedImport.toggleResource(StagedImport.initial(), 'obs-1'),
      new Set()
    )

    expect(plan.linked.map(({ key }) => key)).toEqual([STORED.key])
    expect(plan.formats.map(({ plan: formatPlan }) => formatPlan._tag)).toEqual(['skip'])
  })

  it('does not write a stored copy the server holds unchanged, even while a resource naming it is written', () => {
    const batch = batchWith(
      [observationOf('obs-1', { subject: { reference: STORED_PATIENT } })],
      STORED
    )

    const plan = planBatchWrite(batch, () => StagedImport.initial(), new Set([STORED.key]))

    expect(plan.linked).toEqual([])
  })

  it('writes nothing on a re-import whose rows and linked record the server holds unchanged', () => {
    const batch = batchWith(
      [observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] })],
      PROVISIONAL
    )

    const plan = planBatchWrite(
      batch,
      () => StagedImport.toggleResource(StagedImport.initial(), 'obs-1'),
      new Set([PROVISIONAL.key])
    )

    expect(plan.linked).toEqual([])
    expect(plan.formats.map(({ plan: formatPlan }) => formatPlan._tag)).toEqual(['skip'])
  })

  it('leaves out an unchanged new linked record while a resource naming it is written', () => {
    const batch = batchWith(
      [observationOf('obs-1', { performer: [{ reference: PRACTITIONER }] })],
      PROVISIONAL
    )

    const plan = planBatchWrite(batch, () => StagedImport.initial(), new Set([PROVISIONAL.key]))

    expect(plan.linked).toEqual([])
  })

  it('property: a new linked record is written only beside a written resource naming it, a stored copy whenever the server holds it changed', () => {
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

          const plan = planBatchWrite(
            batchWith(observations, linkedRecord),
            () => selection,
            new Set(unchanged ? [linkedRecord.key] : [])
          )

          const namedAndWritten = observations.some(
            ({ key }, index) => namesLinked[index] && !excludes(key)
          )
          const written = !unchanged && (linkedRecord === STORED || namedAndWritten)
          expect(plan.linked.length).toBe(written ? 1 : 0)
          if (linkedRecord === PROVISIONAL && plan.linked.length > 0) {
            expect(plan.formats.some(({ plan: formatPlan }) => formatPlan._tag === 'write')).toBe(
              true
            )
          }
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
  readonly entry: DecodedFile.Resource
  readonly link: Link.Type
}

/** `linkable`, its `id` known to be set; throws when it has none. */
const withId = (linkable: LinkableResource.Type): LinkableResource.WithId =>
  Option.getOrThrow(LinkableResource.tryIntoWithId(linkable))

/** `linkedResource` as a linked record titled `title`, the link landing on it made by `target`. */
const linkedRecordOf = (
  linkedResource: LinkableResource.WithId,
  title: string,
  target: (linkedTo: LinkableResource.WithId) => LinkTarget.Type
): LinkedRecord => {
  const literalReference = LinkableResource.literalReferenceOf(linkedResource)
  const key = `linked:${literalReference}`
  return {
    key,
    literalReference,
    entry: { key, title, resource: linkedResource },
    link: {
      referent: {
        _tag: 'ByMentionOnly',
        logicalReference: Option.getOrThrow(
          LinkableResource.tryIntoLogicalReference(linkedResource)
        ),
        label: title,
      } satisfies Referent.ByMentionOnly,
      target: target(linkedResource),
    },
  }
}

/** A new linked record: the Practitioner made from a printed name, provisional. */
const PROVISIONAL = linkedRecordOf(
  withId(
    Schema.decodeUnknownSync(Practitioner.Schema)({
      resourceType: 'Practitioner',
      id: 'provisional-1',
      identifier: [
        { system: 'https://source.example/practitioner-name', value: 'Dr. Provisional' },
      ],
    })
  ),
  'Dr. Provisional',
  (provisional) => LinkTarget.Provisional({ resource: provisional })
)

/** A stored copy: the stored Patient a mention is linked to, the batch's identifiers assumed. */
const STORED = linkedRecordOf(
  withId(
    Schema.decodeUnknownSync(Patient.Schema)({
      resourceType: 'Patient',
      id: 's-1',
      identifier: [{ system: 'https://source.example/patient-id', value: 'mrn-1' }],
    })
  ),
  'Stored Patient',
  (stored) => LinkTarget.Stored({ resource: stored })
)

/** An Observation keyed `key` carrying the given reference fields. */
const observationOf = (key: string, references: object): DecodedFile.Resource => ({
  key,
  title: `Observation/${key}`,
  resource: Schema.decodeUnknownSync(Observation.Schema)({
    resourceType: 'Observation',
    id: key,
    status: 'final',
    code: { text: 'Heart rate' },
    ...references,
  }),
})

/** A resolved batch of one HAR format holding `resources`, with `linkedRecord` its one linked record. */
const batchWith = (
  resources: readonly DecodedFile.Resource[],
  linkedRecord: LinkedRecord
): ResolvedBatch => ({
  har: {
    id: 'har/a.har',
    title: 'a.har',
    files: [{ id: '0:a.har', fileName: 'a.har', bytes: new Uint8Array([1]) }],
    format: 'har',
    decoded: { sections: [{ title: 's', resources }], notes: [] },
    unreadableFiles: [],
  },
  'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
  dicom: FormatDecode.emptyResult('dicom'),
  unrecognizedFiles: [],
  linked: [linkedRecord.entry],
  links: [linkedRecord.link],
})
