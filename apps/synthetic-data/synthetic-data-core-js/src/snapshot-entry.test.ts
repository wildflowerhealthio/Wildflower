import { FhirResourceSchema } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Entry from './snapshot-entry.ts'
import type * as SnapshotFile from './snapshot-file.ts'

/**
 * Each entry kind's codec to and from its file, over hand-written files: what
 * a resource's file links, which paths an entry may sit at, and that an
 * attachment reads back as itself. The codecs over real importer output are
 * `snapshot-layout.test.ts`'s.
 */

const RUNS = numRunsFor({ base: 100 })

const decodeFile = Schema.decodeUnknownEither(Entry.FileSchema)

const encodeFile = Schema.encodeEither(Entry.FileSchema)

/** A resource file's attachments, whatever their fields. */
const decodeAttachmentsJson = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ attachment: Schema.Record({ key: Schema.String, value: Schema.Unknown }) })
      ),
    })
  )
)

/** A resource's file holding `json`, at its own path. */
const resourceFile = (json: Record<string, unknown>): SnapshotFile.Text => ({
  _tag: 'Text',
  path: `fhir/${String(json['resourceType'])}/${String(json['id'])}.json`,
  text: `${JSON.stringify(json, null, 2)}\n`,
})

const sourceFileJson = (attachment: Record<string, unknown>): Record<string, unknown> => ({
  resourceType: 'DocumentReference',
  id: 'source-1',
  status: 'current',
  content: [{ attachment: { contentType: 'application/json', title: 'a.har', ...attachment } }],
})

describe('Snapshot.Entry.ResourceFileSchema', () => {
  test('reads a DocumentReference whose one attachment names an attachment by url alone as linking it', () => {
    const file = resourceFile(sourceFileJson({ url: 'har/a.har' }))
    const entry = Either.getOrThrow(decodeFile(file))
    if (entry._tag !== 'Resource') throw new Error('expected a resource')
    expect(entry.attachmentPath).toBe('har/a.har')
    expect(entry.resource).toMatchObject({
      resourceType: 'DocumentReference',
      content: [{ attachment: { data: null, url: null, title: 'a.har' } }],
    })
    // And writes it back linking the same attachment.
    const written = Either.getOrThrow(encodeFile(entry))
    if (written._tag !== 'Text') throw new Error('expected text')
    expect(written.path).toBe(file.path)
    const { content } = decodeAttachmentsJson(written.text)
    const [attachment] = content.map((one) => one.attachment)
    expect(attachment).toMatchObject({
      contentType: 'application/json',
      title: 'a.har',
      url: 'har/a.har',
    })
    expect(attachment).not.toHaveProperty('data')
  })

  test('reads a DocumentReference carrying its data inline as linking nothing', () => {
    const entry = Either.getOrThrow(decodeFile(resourceFile(sourceFileJson({ data: 'aGVsbG8=' }))))
    if (entry._tag !== 'Resource') throw new Error('expected a resource')
    expect(entry.attachmentPath).toBeUndefined()
    expect(entry.resource).toMatchObject({ content: [{ attachment: { data: 'aGVsbG8=' } }] })
  })

  test('reads a DocumentReference linking outside the snapshot as linking nothing', () => {
    const entry = Either.getOrThrow(
      decodeFile(resourceFile(sourceFileJson({ url: 'https://example.com/a.har' })))
    )
    if (entry._tag !== 'Resource') throw new Error('expected a resource')
    expect(entry.attachmentPath).toBeUndefined()
    expect(entry.resource).toMatchObject({
      content: [{ attachment: { url: new URL('https://example.com/a.har') } }],
    })
  })

  test.each([
    ['carries its data beside a relative url', { url: 'har/a.har', data: 'aGVsbG8=' }],
    ['links to a parent directory', { url: 'har/../index.json' }],
  ])('does not read a DocumentReference that %s', (_, attachment) => {
    expect(Either.isLeft(decodeFile(resourceFile(sourceFileJson(attachment))))).toBe(true)
  })

  test('does not read a resource at another resource’s path', () => {
    const file = resourceFile({ resourceType: 'Patient', id: 'a' })
    expect(Either.isLeft(decodeFile({ ...file, path: 'fhir/Patient/b.json' }))).toBe(true)
    expect(Either.isLeft(decodeFile({ ...file, path: 'fhir/Observation/a.json' }))).toBe(true)
    expect(Either.isRight(decodeFile(file))).toBe(true)
  })

  test('does not write a resource linking an attachment it carries inline', () => {
    const resource = Schema.decodeUnknownSync(FhirResourceSchema)(
      sourceFileJson({ data: 'aGVsbG8=' })
    )
    if (resource.id === null) throw new Error('expected an id')
    expect(
      Either.isLeft(
        encodeFile({
          _tag: 'Resource',
          resource: { ...resource, id: resource.id },
          attachmentPath: 'har/a.har',
        })
      )
    ).toBe(true)
  })

  test('writes JSON two-space indented with a trailing newline, and reads back what it wrote', () => {
    const entry = Either.getOrThrow(
      decodeFile(resourceFile({ resourceType: 'Patient', id: 'a', gender: 'female' }))
    )
    const written = Either.getOrThrow(encodeFile(entry))
    if (written._tag !== 'Text') throw new Error('expected text')
    expect(written.text).toBe(`${JSON.stringify(JSON.parse(written.text), null, 2)}\n`)
    expect(JSON.parse(written.text)).toMatchObject({
      resourceType: 'Patient',
      id: 'a',
      gender: 'female',
    })
    expect(Either.flatMap(decodeFile(written), (read) => encodeFile(read))).toEqual(
      Either.right(written)
    )
  })
})

describe('Snapshot.Entry.AttachmentFileSchema', () => {
  const attachmentArbitrary: fc.Arbitrary<Entry.Attachment> = fc.record({
    _tag: fc.constant('Attachment' as const),
    format: fc.constantFrom(...Entry.FORMATS),
    fileName: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/),
    bytes: fc.uint8Array({ maxLength: 64 }),
  })

  test('property: an attachment is its bytes at <format>/<file name>, and reads back as itself', () => {
    fc.assert(
      fc.property(attachmentArbitrary, (attachment) => {
        const file = Either.getOrThrow(encodeFile(attachment))
        expect(file).toEqual({
          _tag: 'Bytes',
          path: `${attachment.format}/${attachment.fileName}`,
          bytes: attachment.bytes,
        })
        expect(Entry.pathOf(attachment)).toBe(file.path)
        expect(decodeFile(file)).toEqual(Either.right(attachment))
      }),
      { numRuns: RUNS }
    )
  })

  test.each(['har/../index.json', 'pdf/report.pdf', 'har/a/b.har', 'har/.hidden'])(
    'does not read bytes at %j',
    (path) => {
      expect(Either.isLeft(decodeFile({ _tag: 'Bytes', path, bytes: new Uint8Array() }))).toBe(true)
    }
  )
})

describe('Snapshot.Entry path schemas', () => {
  test.each([
    'fhir/Patient/abc.json',
    'fhir/DocumentReference/wf-0123.json',
    'fhir/Observation/a.b-c.json',
  ])('accepts the resource path %j', (path) => {
    expect(Schema.is(Entry.ResourcePathSchema)(path)).toBe(true)
  })

  test.each([
    'fhir/Patient/../index.json',
    'fhir/Patient/a/b.json',
    'fhir/patient/abc.json',
    '/fhir/Patient/abc.json',
    'fhir/Patient/abc.json/',
    `fhir/Patient/${'a'.repeat(65)}.json`,
  ])('rejects the resource path %j', (path) => {
    expect(Schema.is(Entry.ResourcePathSchema)(path)).toBe(false)
  })

  test.each(['har/family.har', 'dicom/chest-x-ray.dcm', 'dicom/IMG_0001.dcm'])(
    'accepts the attachment path %j',
    (path) => {
      expect(Schema.is(Entry.AttachmentPathSchema)(path)).toBe(true)
    }
  )

  test.each(['har/../index.json', 'har/.hidden', 'pdf/report.pdf', 'har/a/b.har', 'har/', 'har'])(
    'rejects the attachment path %j',
    (path) => {
      expect(Schema.is(Entry.AttachmentPathSchema)(path)).toBe(false)
    }
  )

  test('names the attachment formats after the importers’ formats', () => {
    expect(Entry.FORMATS).toEqual(['har', 'dicom'])
  })
})
