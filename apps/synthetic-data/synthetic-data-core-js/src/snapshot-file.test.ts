import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as SnapshotFile from './snapshot-file.ts'

/** The encoded side: JSON text as a snapshot writes it, and files compared and ordered. */

const RUNS = numRunsFor({ base: 100 })

describe('SnapshotFile.JsonTextSchema', () => {
  test('property: writes JSON two-space indented with a trailing newline, and reads it back', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        const text = Schema.encodeSync(SnapshotFile.JsonTextSchema)(json)
        expect(text).toBe(`${JSON.stringify(json, null, 2)}\n`)
        expect(Schema.decodeSync(SnapshotFile.JsonTextSchema)(text)).toEqual(JSON.parse(text))
      }),
      { numRuns: RUNS }
    )
  })

  test('reads JSON text with no trailing newline, and does not read text that is not JSON', () => {
    expect(Schema.decodeEither(SnapshotFile.JsonTextSchema)('{"a":1}')).toEqual(
      Either.right({ a: 1 })
    )
    expect(Either.isLeft(Schema.decodeEither(SnapshotFile.JsonTextSchema)('{'))).toBe(true)
  })
})

describe('SnapshotFile.same', () => {
  const text = (path: string, contents: string): SnapshotFile.Any => ({
    _tag: 'Text',
    path,
    text: contents,
  })
  const bytes = (path: string, contents: readonly number[]): SnapshotFile.Any => ({
    _tag: 'Bytes',
    path,
    bytes: new Uint8Array(contents),
  })

  test('is the same file for one path and the same contents only', () => {
    expect(SnapshotFile.same(text('a', 'x'), text('a', 'x'))).toBe(true)
    expect(SnapshotFile.same(text('a', 'x'), text('a', 'y'))).toBe(false)
    expect(SnapshotFile.same(text('a', 'x'), text('b', 'x'))).toBe(false)
    expect(SnapshotFile.same(bytes('a', [1, 2]), bytes('a', [1, 2]))).toBe(true)
    expect(SnapshotFile.same(bytes('a', [1, 2]), bytes('a', [1, 3]))).toBe(false)
    expect(SnapshotFile.same(bytes('a', [1]), bytes('a', [1, 2]))).toBe(false)
    expect(SnapshotFile.same(text('a', ''), bytes('a', []))).toBe(false)
  })

  test('orders files by path, by code unit', () => {
    expect(
      [text('index.json', ''), bytes('dicom/a.dcm', []), text('fhir/Patient/a.json', '')]
        .toSorted(SnapshotFile.byPath)
        .map(({ path }) => path)
    ).toEqual(['dicom/a.dcm', 'fhir/Patient/a.json', 'index.json'])
  })
})
