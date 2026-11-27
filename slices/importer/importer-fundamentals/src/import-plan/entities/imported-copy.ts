/**
 * An imported copy: one copy of a record, as one file set of an import brought
 * it through the import stage, before anything is chosen.
 *
 * @packageDocumentation
 */
import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Data, Option } from 'effect'

import type * as DecodedFileSet from '../../decoded-file-set.ts'
import type * as FileImporter from '../../file-importer.ts'
import * as FormatDecode from '../../format-decode.ts'
import * as ResourcePlan from '../../resource-plan.ts'
import type * as FileSetOrigin from './file-set-origin.ts'
import * as RecordKey from './record-key.ts'

/**
 * The id the import stage gave a copy: `Derived`, the same on every import,
 * from the key of a record keyed by identifier or from a source file's
 * content, so a stored copy of the record from an earlier import sits under
 * it; or `Minted` for a decoded record with no key identifier, new on every
 * import.
 *
 * @remarks
 * Not `ResourcePlan.Type`: a source file's id is derived from its content and
 * has no key identifier to make a `ResourcePlan.Derived` of, yet it is as
 * stable across imports as the id of a record keyed by identifier.
 */
type StageId = Data.TaggedEnum<{
  Derived: { readonly id: string }
  Minted: { readonly id: string }
}>

const { Derived, Minted, $is: isStageId } = Data.taggedEnum<StageId>()

/**
 * One copy of a record, from one file set: the record as the import stage
 * finished it (placed, linked to its source files and stamped, its
 * references as decoded), detached, beside where it came from, how the plan
 * shows it, and the id the stage gave it.
 */
interface Type {
  /** The file set the copy came from. */
  readonly origin: FileSetOrigin.Type
  /** The copy's review key, unique within the batch. */
  readonly reviewKey: string
  /** The title the plan shows the copy under. */
  readonly title: string
  /** Whether the import built the record from a reference to it (`ReviewRow.Type`'s `isImplied`). */
  readonly isImplied: boolean
  readonly resource: DetachedResource.Type
  /** The URL a source served the record at (`FileSetRecord.Type`'s `sourceUrl`). */
  readonly sourceUrl: Option.Option<URL>
  readonly stageId: StageId
}

/**
 * The copy of a record of the set `origin` names, from its row as the import
 * stage finished it: given its review key, titled and given its id as
 * placing decided (`DecodedFileSet.placedRowsOf`), then linked and stamped.
 */
const fromPlacedRow = (
  origin: FileSetOrigin.Type,
  { reviewKey, title, isImplied, resource, placed }: DecodedFileSet.PlacedRow
): Type => ({
  origin,
  reviewKey,
  title,
  isImplied,
  resource: { ...resource, id: null },
  sourceUrl: placed.record.sourceUrl,
  stageId: ResourcePlan.match(placed.plan, {
    Derived: ({ id }) => Derived({ id }),
    Minted: ({ id }) => Minted({ id }),
  }),
})

/**
 * The copy of the source file one picked file of the set `origin` names is
 * stored as, as the import stage finished it (minted, carrying what the file
 * identified itself as, linked to the set's records), its content-derived id
 * its stage id.
 */
const fromSourceFile = (
  origin: FileSetOrigin.Type,
  { pickedFile, sourceFile }: FileImporter.PickedSourceFile
): Type => ({
  origin,
  reviewKey: FormatDecode.sourceFileKey(pickedFile),
  title: pickedFile.fileName,
  isImplied: false,
  resource: { ...sourceFile, id: null },
  sourceUrl: Option.none(),
  stageId: Derived({ id: sourceFile.id }),
})

/** Whether the import stage derived `copy`'s id ({@link StageId}), so it is the same on every import. */
const hasDerivedStageId = (copy: Type): boolean => isStageId('Derived')(copy.stageId)

/** The literal reference the import stage gives `copy`, `<Type>/<id>` under its stage id. */
const stageLiteralOf = ({ resource, stageId }: Type): string =>
  `${resource.resourceType}/${stageId.id}`

/** The key of the record `copy` is a copy of (`RecordKey.make`). */
const recordKeyOf = ({ resource, sourceUrl, reviewKey }: Type): RecordKey.Type =>
  RecordKey.make({ resource, sourceUrl, importerAssignedKey: reviewKey })

export { fromPlacedRow, fromSourceFile, hasDerivedStageId, recordKeyOf, stageLiteralOf }
export type { StageId, Type }
