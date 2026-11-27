/**
 * A reference table: where a reference to each record of an import lands,
 * by every spelling the import's copies name a record by, and the pass that
 * resolves a resource by it.
 *
 * @packageDocumentation
 */
import { ReferencePlan, resolveReferences } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference, ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  LogicalReference,
  ResourceReferences,
  type ResourceType,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Data, HashMap, Match, Option, pipe } from 'effect'

import * as MetaSource from '../../meta-source.ts'

/**
 * Where a reference to one record lands: a literal reference to where the
 * record is written or linked, or a name-only stub (its `type`, `identifier`
 * and `display`, no literal) shown as `display`, when there is one, if the
 * reference has no `display` of its own.
 *
 * @remarks
 * A stub names the record by `resourceType` and, when it has one, its
 * `keyIdentifier`, when a reference spelled it by its stage literal. A record
 * with no key identifier is named by its type and display alone: nothing is
 * written under its stage literal, so the literal is never kept.
 * A reference with no target in the table is left as it is.
 */
type Target = Data.TaggedEnum<{
  Literal: { readonly literalReference: string }
  Stub: {
    readonly resourceType: ResourceType.Type
    readonly keyIdentifier: Option.Option<IdentifierAndReference.QualifiedIdentifierType>
    readonly display: Option.Option<string>
  }
}>

const { Literal, Stub } = Data.taggedEnum<Target>()

/**
 * Each record's target by the spellings a reference names it by: a logical
 * reference (by `LogicalReference.key`), the literal the import stage wrote
 * it under, and, through `fhir-r4-adoption`'s reference plan, the literal
 * targets of logical references and of the URLs a source served records at.
 */
interface Type {
  readonly byLogicalReference: HashMap.HashMap<LogicalReference.Key, Target>
  readonly byStageLiteral: HashMap.HashMap<string, Target>
  readonly referencePlan: ReferencePlan.Type
}

/** `target`'s literal reference; `None` for a stub. */
const literalReferenceIfLiteral = (target: Target): Option.Option<string> =>
  target._tag === 'Literal' ? Option.some(target.literalReference) : Option.none()

/** What `target` shows when it is a stub with something to show; `None` for a literal. */
const displayIfStub = (target: Target): Option.Option<string> =>
  target._tag === 'Stub' ? target.display : Option.none()

/**
 * The table of the targets of `logicalReferences`, of `stageLiterals` and of
 * `sourceUrls`, each spelling beside the target a reference spelling it
 * lands on.
 *
 * @remarks
 * A source URL with a stub target is left out: an `Attachment.url` or a
 * reference spelling it keeps the source's URL.
 */
const make = ({
  logicalReferences,
  stageLiterals,
  sourceUrls,
}: {
  readonly logicalReferences: readonly {
    readonly logicalReference: LogicalReference.Type
    readonly target: Target
  }[]
  readonly stageLiterals: readonly { readonly stageLiteral: string; readonly target: Target }[]
  readonly sourceUrls: readonly { readonly sourceUrl: URL; readonly target: Target }[]
}): Type => ({
  byLogicalReference: HashMap.fromIterable(
    logicalReferences.map(
      ({ logicalReference, target }) => [LogicalReference.key(logicalReference), target] as const
    )
  ),
  byStageLiteral: HashMap.fromIterable(
    stageLiterals.map(({ stageLiteral, target }) => [stageLiteral, target] as const)
  ),
  referencePlan: ReferencePlan.of(
    Arr.filterMap(logicalReferences, ({ logicalReference, target }) =>
      Option.map(literalReferenceIfLiteral(target), (literalReference) => ({
        logicalReference,
        literalReference,
      }))
    ),
    Arr.filterMap(sourceUrls, ({ sourceUrl, target }) =>
      Option.map(literalReferenceIfLiteral(target), (literalReference) => ({
        sourceUrl,
        literalReference,
      }))
    )
  ),
})

/**
 * `heldReference`, which names a record by its stage literal, landed on
 * `target`: the target's literal, or a stub by the record's type, its key
 * identifier when it has one, and its display, the reference's own `type`,
 * `identifier` and `display` kept where it has them.
 */
const stageLiteralLanded = (heldReference: ReferenceType, target: Target): ReferenceType =>
  Match.value(target).pipe(
    Match.tagsExhaustive({
      Literal: ({ literalReference }) => ({ ...heldReference, reference: literalReference }),
      Stub: ({ resourceType, keyIdentifier, display }) => ({
        ...heldReference,
        reference: null,
        type: heldReference.type ?? resourceType,
        identifier: heldReference.identifier ?? Option.getOrNull(keyIdentifier),
        display: heldReference.display ?? Option.getOrNull(display),
      }),
    })
  )

/** `resource` with each reference by a record's stage literal landed ({@link stageLiteralLanded}). */
const withStageLiteralsLanded = <TResource extends FhirResource>(
  table: Type,
  resource: TResource
): TResource =>
  ResourceReferences.mapReferences(resource, (heldReference) =>
    pipe(
      Option.fromNullable(heldReference.reference),
      Option.flatMap((stageLiteral) => HashMap.get(table.byStageLiteral, stageLiteral)),
      Option.match({
        onNone: () => heldReference,
        onSome: (target) => stageLiteralLanded(heldReference, target),
      })
    )
  )

/**
 * `resource` with each logical reference to a record with a stub target
 * given the stub's display, when there is one, if it has no `display` of its
 * own.
 */
const withStubDisplays = <TResource extends FhirResource>(
  table: Type,
  resource: TResource
): TResource =>
  ResourceReferences.mapReferences(resource, (heldReference) =>
    pipe(
      Option.liftPredicate(heldReference, ({ display }) => display === null),
      Option.flatMap(LogicalReference.tryFromReference),
      Option.flatMap((unlinkedReference) =>
        HashMap.get(table.byLogicalReference, LogicalReference.key(unlinkedReference))
      ),
      Option.flatMap(displayIfStub),
      Option.map((display) => ({ ...heldReference, display })),
      Option.getOrElse(() => heldReference)
    )
  )

/**
 * `resource` with its `meta.source`, the stage literal of the source file it
 * was read from (`MetaSource.sourceOf`), stamped where that source file lands
 * when it lands on a literal; otherwise as it is.
 */
const withSourceLanded = <TResource extends FhirResource>(
  table: Type,
  resource: TResource
): TResource =>
  pipe(
    MetaSource.sourceOf(resource),
    Option.flatMap((source) => HashMap.get(table.byStageLiteral, source)),
    Option.flatMap(literalReferenceIfLiteral),
    Option.filter(MetaSource.isReference),
    Option.match({
      onNone: () => resource,
      onSome: (landed) => MetaSource.stamp(resource, landed),
    })
  )

/**
 * The literal reference `table` lands `logicalReference` on: `None` when it
 * lands on a stub or nowhere, or on several literals that disagree
 * (`ReferencePlan.literalReferenceFor`).
 */
const literalReferenceFor = (
  table: Type,
  logicalReference: LogicalReference.Type
): Option.Option<string> => ReferencePlan.literalReferenceFor(table.referencePlan, logicalReference)

/**
 * `resource` with its references resolved by `table`: each by a record's
 * stage literal landed where the record's target says; each logical one to
 * a stub given its display; each logical one with a literal target made
 * literal, and every `Attachment.url` or literal spelling a source URL with
 * a literal target pointed at it (`resolveReferences`, the pass a file set
 * is adopted by); its `meta.source` landed with its source file; every other
 * reference as it is.
 */
const resolve = <TResource extends FhirResource>(table: Type, resource: TResource): TResource =>
  withSourceLanded(
    table,
    resolveReferences(
      table.referencePlan,
      withStubDisplays(table, withStageLiteralsLanded(table, resource))
    )
  )

export { Literal, literalReferenceFor, make, resolve, Stub }
export type { Target, Type }
