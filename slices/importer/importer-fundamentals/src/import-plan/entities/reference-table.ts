/**
 * A reference table: where a reference to each record of an import lands,
 * by every spelling the import's copies name a record by, and the pass that
 * resolves a resource by it.
 *
 * @packageDocumentation
 */
import { ReferencePlan, resolveReferences } from '@wildflowerhealthio/fhir-r4-adoption'
import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  LogicalReference,
  ResourceReferences,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Data, Effect, HashMap, Match, Option, pipe } from 'effect'

import * as MetaSource from '../../meta-source.ts'

/**
 * Where a reference to one record lands: a literal reference to where the
 * record is written or linked, or a name-only stub (its `type`, `identifier`
 * and `display`, no literal) shown as `display`, when there is one, if the
 * reference has no `display` of its own.
 *
 * @remarks
 * `keyedBy` is the logical reference a stub names the record by when a
 * reference spelled it by its stage literal; `None` for a keyless record,
 * which has nothing to be named by, so such a reference keeps its literal.
 * A reference with no target in the table is left as it is.
 */
type Target = Data.TaggedEnum<{
  Literal: { readonly literalReference: string }
  Stub: {
    readonly display: Option.Option<string>
    readonly keyedBy: Option.Option<LogicalReference.Type>
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
  readonly logicalReferences: readonly (readonly [LogicalReference.Type, Target])[]
  readonly stageLiterals: readonly (readonly [string, Target])[]
  readonly sourceUrls: readonly (readonly [URL, Target])[]
}): Type => ({
  byLogicalReference: HashMap.fromIterable(
    logicalReferences.map(
      ([logicalReference, target]) => [LogicalReference.key(logicalReference), target] as const
    )
  ),
  byStageLiteral: HashMap.fromIterable(stageLiterals),
  referencePlan: ReferencePlan.of(
    Arr.filterMap(logicalReferences, ([logicalReference, target]) =>
      Option.map(literalReferenceIfLiteral(target), (literalReference) => ({
        logicalReference,
        literalReference,
      }))
    ),
    Arr.filterMap(sourceUrls, ([sourceUrl, target]) =>
      Option.map(literalReferenceIfLiteral(target), (literalReference) => ({
        sourceUrl,
        literalReference,
      }))
    )
  ),
})

/**
 * `reference`, which names a record by its stage literal, landed on
 * `target`: the target's literal, or a stub by the record's key; a keyless
 * record's stub keeps the literal.
 */
const stageLiteralLanded = (reference: ReferenceType, target: Target): ReferenceType =>
  Match.value(target).pipe(
    Match.tagsExhaustive({
      Literal: ({ literalReference }) => ({ ...reference, reference: literalReference }),
      Stub: ({ display, keyedBy }) =>
        Option.match(keyedBy, {
          onNone: () => reference,
          onSome: ({ resourceType, identifier: [identifier] }) => ({
            ...reference,
            reference: null,
            type: reference.type ?? resourceType,
            identifier: reference.identifier ?? identifier,
            display: reference.display ?? Option.getOrNull(display),
          }),
        }),
    })
  )

/** `resource` with each reference by a record's stage literal landed ({@link stageLiteralLanded}). */
const withStageLiteralsLanded = <TResource extends FhirResource>(
  table: Type,
  resource: TResource
): TResource =>
  ResourceReferences.mapReferences(resource, (reference) =>
    pipe(
      Option.fromNullable(reference.reference),
      Option.flatMap((literal) => HashMap.get(table.byStageLiteral, literal)),
      Option.match({
        onNone: () => reference,
        onSome: (target) => stageLiteralLanded(reference, target),
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
  ResourceReferences.mapReferences(resource, (reference) =>
    pipe(
      LogicalReference.tryFromReference(reference),
      Option.flatMap((logicalReference) =>
        HashMap.get(table.byLogicalReference, LogicalReference.key(logicalReference))
      ),
      Option.flatMap((target) =>
        target._tag === 'Stub' && reference.display === null
          ? Option.map(target.display, (display) => ({ ...reference, display }))
          : Option.none()
      ),
      Option.getOrElse(() => reference)
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
 * `resource` with its references resolved by `table`: each by a record's
 * stage literal landed where the record's target says; each logical one to
 * a stub given its display; each logical one with a literal target made
 * literal, and every `Attachment.url` or literal spelling a source URL with
 * a literal target pointed at it (`resolveReferences`, the pass a file set
 * is adopted by); its `meta.source` landed with its source file; every other
 * reference as it is.
 */
const resolve = <TResource extends FhirResource>(
  table: Type,
  resource: TResource
): Effect.Effect<TResource> =>
  resolveReferences(withStubDisplays(table, withStageLiteralsLanded(table, resource))).pipe(
    Effect.map((resolved) => withSourceLanded(table, resolved)),
    Effect.provideService(ReferencePlan.InForce, table.referencePlan)
  )

export { Literal, make, resolve, Stub }
export type { Target, Type }
