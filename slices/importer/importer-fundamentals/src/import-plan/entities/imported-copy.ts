/**
 * An imported copy: one copy of a record, as one file set of an import brought
 * it through the import stage, before anything is chosen.
 *
 * @packageDocumentation
 */
import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Option } from 'effect'

import * as DecodedFileSet from '../../decoded-file-set.ts'
import * as FormatDecode from '../../format-decode.ts'
import type * as PickedFile from '../../picked-file.ts'
import * as ResourcePlan from '../../resource-plan.ts'
import * as FileSetOrigin from './file-set-origin.ts'
import * as RecordKey from './record-key.ts'

/**
 * One copy of a record, from one file set: the record as that set holds it,
 * detached, beside where it came from and how the plan shows it.
 *
 * @remarks
 * `derivedId` is the id a stored copy of the record from an earlier import
 * sits under: a keyed record's id derived from its key, or a source file's id
 * derived from its content. `None` for a keyless decoded record, whose id is
 * minted anew on every import.
 */
interface Type {
  /** The file set the copy came from. */
  readonly origin: FileSetOrigin.Type
  /** The copy's review key, unique within its format. */
  readonly reviewKey: string
  /** The title the plan shows the copy under. */
  readonly title: string
  /** Whether the import built the record from a reference to it (`ReviewRow.Type`'s `isImplied`). */
  readonly isImplied: boolean
  readonly resource: DetachedResource.Type
  /** The URL a source served the record at (`FileSetRecord.Type`'s `sourceUrl`). */
  readonly sourceUrl: Option.Option<URL>
  readonly derivedId: Option.Option<string>
}

/**
 * The copy of a record the import stage placed in the set `origin` names
 * (`DecodedFileSet.placedRecordsOf`), keyed by the set's key prefix before
 * the record's local key and titled as the import stage titles its row.
 *
 * @remarks
 * The id placing minted for a keyless record is not kept: a copy holds its
 * record detached.
 */
const fromPlacedRecord = (
  origin: FileSetOrigin.Type,
  { record, plan, isImplied }: DecodedFileSet.PlacedRecord
): Type => {
  const reviewKey = `${FileSetOrigin.keyPrefixOf(origin)}${record.localKey}`
  return {
    origin,
    reviewKey,
    title: DecodedFileSet.writtenReferenceTitle(plan, reviewKey),
    isImplied,
    resource: record.resource,
    sourceUrl: record.sourceUrl,
    derivedId: ResourcePlan.match(plan, {
      Derived: ({ id }) => Option.some(id),
      Minted: () => Option.none(),
    }),
  }
}

/**
 * The copy of the source file one picked file of the set `origin` names is
 * stored as: `sourceFile` as the import stage mints it, carrying what the
 * file identified itself as, detached, its content-derived id kept as its
 * derived id.
 */
const fromSourceFile = (
  origin: FileSetOrigin.Type,
  { pickedFile, identifiedAs }: DecodedFileSet.PickedFileIdentity,
  sourceFile: PickedFile.SourceFile
): Type => ({
  origin,
  reviewKey: FormatDecode.sourceFileKey(pickedFile),
  title: pickedFile.fileName,
  isImplied: false,
  resource: { ...sourceFile, id: null, masterIdentifier: Option.getOrNull(identifiedAs) },
  sourceUrl: Option.none(),
  derivedId: Option.some(sourceFile.id),
})

/** The key of the record `copy` is a copy of (`RecordKey.make`). */
const recordKeyOf = (copy: Type): RecordKey.Type => RecordKey.make(copy.resource, copy.reviewKey)

export { fromPlacedRecord, fromSourceFile, recordKeyOf }
export type { Type }
