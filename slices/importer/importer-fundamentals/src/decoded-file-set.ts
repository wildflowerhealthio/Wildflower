/**
 * One file set as its format decoded it: the picked files read together, and
 * the records read out of them, before the import stage makes them the
 * device's.
 *
 * @packageDocumentation
 */
import {
  adopt as adoptRecord,
  DetachedResource,
  randomResourceId,
  ReferencePlan,
} from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference, type ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import { LogicalReference, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Either, Option, type ParseResult, pipe } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
import * as ImpliedRecord from './implied-record.ts'
import type * as PickedFile from './picked-file.ts'
import * as ResourcePlan from './resource-plan.ts'

/**
 * One record of a section: the record as its source gave it, detached
 * (`fhir-r4-adoption`'s `DetachedResource`: no id, keyed by its first
 * identifier, naming every other record it decoded by a logical reference),
 * beside its identity within the decoded set.
 *
 * @remarks
 * `fullUrl` plays the part of FHIR's `Bundle.entry.fullUrl` in a transaction:
 * the record's identity within the set before it is stored, which the
 * review tracks an exclusion or an edit by. It is stable across a settings
 * re-decode, and unique within the set once `namespaceKeys` prefixes it. It is
 * not the record's `id`: `id: null` is what marks a record detached.
 */
interface Entry {
  readonly fullUrl: string
  readonly resource: DetachedResource.Type
}

/**
 * A titled group of records from one source batch, as the import stage
 * receives it: each record detached, beside its `fullUrl`.
 *
 * @remarks
 * A decoder builds one per batch it reads: LifeLabs one per report, DICOM one
 * per study, the HAR importer one per response URL. Each decoder writes or
 * detaches its records itself, so a section carries no source base URL or
 * system: everything the import stage needs to adopt a record is on the
 * record.
 *
 * A separate type from `DecodedFile.Section`, the same records adopted: the
 * two differ in what their records are, and every reader of a decoded file
 * reads `resources` off it.
 *
 * The section listing a set's source files is built by the import stage,
 * never decoded.
 */
interface Section {
  readonly title: string
  readonly entries: readonly Entry[]
}

/**
 * A record's review title, the one title every decoded record is reviewed
 * under, read off its plan: for a keyed record, the literal reference the
 * import stage writes it under, `<Type>/<id>`, its derived id; for a keyless
 * record, whose minted id changes on every re-decode, its type and its
 * `fullUrl`, `<Type> (<fullUrl>)`.
 *
 * @param plan - The plan of `entry`'s record
 * @param entry - The decoded record and its `fullUrl`
 */
const writtenReferenceTitle = (plan: ResourcePlan.Type, { fullUrl }: Entry): string =>
  ResourcePlan.match(plan, {
    Derived: ResourcePlan.literalReference,
    Minted: ({ resourceType }) => `${resourceType} (${fullUrl})`,
  })

/**
 * One picked file of a set, beside what its own content identifies it as.
 *
 * @remarks
 * `identifiedAs` is a FHIR `Identifier` the decode read out of the file, for a
 * format whose files name themselves (a DICOM file's SOP Instance UID), and
 * `None` for one whose files do not. The import stage writes it onto the
 * file's source file as `DocumentReference.masterIdentifier`, which is how a
 * record names the source file it was read from without the decode knowing
 * that source file (`FileImporter`'s `linkToSourceFiles`).
 */
interface PickedFileIdentity {
  readonly pickedFile: PickedFile.Type
  readonly identifiedAs: Option.Option<IdentifierAndReference.IdentifierType>
}

/**
 * One file set's decode: its picked files, in the order they were picked, each
 * with what it identifies itself as, and its sections and notes, every review
 * key already namespaced by the set's first picked file
 * (`FormatDecode.keyPrefix`).
 */
interface Type {
  readonly pickedFiles: Arr.NonEmptyReadonlyArray<PickedFileIdentity>
  readonly sections: readonly Section[]
  readonly notes: readonly string[]
}

/** `pickedFile`, identifying as nothing: a picked file of a format whose files do not name themselves. */
const unidentified = (pickedFile: PickedFile.Type): PickedFileIdentity => ({
  pickedFile,
  identifiedAs: Option.none(),
})

/**
 * Prefix every `fullUrl` in `sections`, so one file set's cannot collide with
 * another's once the batch merges their sections.
 *
 * @param prefix - The set's key namespace, from `FormatDecode.keyPrefix`
 */
const namespaceKeys = (sections: readonly Section[], prefix: string): readonly Section[] =>
  sections.map(({ title, entries }) => ({
    title,
    entries: entries.map((entry) => ({ ...entry, fullUrl: `${prefix}${entry.fullUrl}` })),
  }))

/**
 * The entries a planned record gives its set's reference plan: one for each
 * qualified identifier of a keyed record, its key and every other, each
 * resolving to the literal reference the record is written under; none for a
 * keyless record, which nothing names.
 *
 * @remarks
 * A FHIR conditional reference matches a record by any of its identifiers,
 * so a reference resolves whichever of them it names. The same identifier
 * listed twice gives the same entry twice, which `ReferencePlan.of` holds as
 * one; an identifier two records share is the clash it holds as ambiguous.
 *
 * @param plan - The plan of `resource`
 * @param resource - The detached record `plan` was planned from
 */
const referencePlanEntriesOf = (
  plan: ResourcePlan.Type,
  resource: DetachedResource.Type
): readonly ReferencePlan.Entry[] =>
  ResourcePlan.match(plan, {
    Derived: (derived) =>
      DetachedResource.hasIdentifier(resource)
        ? resource.identifier
            .filter(IdentifierAndReference.isQualifiedIdentifier)
            .map((identifier) => ({
              logicalReference: LogicalReference.make(derived.resourceType, identifier),
              literalReference: ResourcePlan.literalReference(derived),
            }))
        : [],
    Minted: () => [],
  })

/**
 * One entry of a set beside its plan, decided before any record of the set is
 * adopted, and where it came from: a decoder's entry, or one the set's
 * references imply.
 */
interface PlannedEntry {
  readonly entry: Entry
  readonly plan: ResourcePlan.Type
  readonly origin: DecodedFile.Origin
}

/** A section with each of its entries planned. */
interface PlannedSection {
  readonly title: string
  readonly plannedEntries: readonly PlannedEntry[]
}

/** Every planned entry of `plannedSections`, in section order. */
const plannedEntriesOf = (plannedSections: readonly PlannedSection[]): readonly PlannedEntry[] =>
  plannedSections.flatMap((section) => section.plannedEntries)

/** The reference plan of a set's planned entries ({@link referencePlanEntriesOf}). */
const referencePlanOf = (plannedEntries: readonly PlannedEntry[]): ReferencePlan.Type =>
  ReferencePlan.of(
    plannedEntries.flatMap(({ entry, plan }) => referencePlanEntriesOf(plan, entry.resource))
  )

/** The title of the section a set's implied records are reviewed in, the last of its sections. */
const IMPLIED_SECTION_TITLE = 'Implied records'

/**
 * Plan ids: each decoded entry of `sections` beside its plan
 * (`ResourcePlan.of`), a keyed record's id derived from its key and a
 * keyless one's minted, in entry order, every one `Decoded`.
 *
 * @remarks
 * As a FHIR server processing a transaction bundle first decides the id
 * every entry is stored under, before it rewrites any reference between them.
 */
const planSections = (
  sections: readonly Section[],
  mintId: () => string
): readonly PlannedSection[] =>
  sections.map(({ title, entries }) => ({
    title,
    plannedEntries: entries.map((entry): PlannedEntry => ({
      entry,
      plan: ResourcePlan.of(entry.resource, mintId),
      origin: 'Decoded',
    })),
  }))

/**
 * A logical reference of a set to a record no record of the set is, beside
 * what the reference says of it, its `display`, and the `fullUrl` of the
 * entry holding it.
 */
interface ImpliedTarget {
  readonly logicalReference: LogicalReference.Type
  readonly display: string
  readonly referencingFullUrl: string
}

/**
 * Every reference of `plannedEntries`, at any depth, in entry order, that
 * names a record the set does not hold: a logical reference
 * (`LogicalReference.tryFromReference`) with a `display` that no record of the
 * set holds by any identifier (`ReferencePlan.holds` of `heldPlan`).
 */
const impliedTargetsOf = (
  plannedEntries: readonly PlannedEntry[],
  heldPlan: ReferencePlan.Type
): readonly ImpliedTarget[] =>
  pipe(
    plannedEntries,
    Arr.flatMap(({ entry }) =>
      Arr.filterMap(ResourceReferences.collect(entry.resource), ({ reference }) =>
        Option.all({
          logicalReference: LogicalReference.tryFromReference(reference),
          display: Option.fromNullable(reference.display),
          referencingFullUrl: Option.some(entry.fullUrl),
        })
      )
    ),
    Arr.filter(({ logicalReference }) => !ReferencePlan.holds(heldPlan, logicalReference))
  )

/**
 * Imply: the section of the records the references of `plannedSections`
 * imply, `None` when they imply none. Each record is one a logical reference
 * names and no record of the set holds ({@link impliedTargetsOf}), built for
 * its type by `ImpliedRecord.of`, keyed by the reference's identifier and
 * named by its display, under a `fullUrl` read off the entry holding it
 * (`ImpliedRecord.fullUrlOf`), planned and `Implied`. One record covers
 * every reference to one target: the first to name it, in entry order, is
 * the one it is built from.
 *
 * @remarks
 * A reference names a record the import never saw: a Rexall prescriber
 * carebook names as `Practitioner/<id>` and never serves, or a provider a
 * source knows only by a printed name it keys in its own name system. Once
 * the set holds the record, every reference to it resolves to it, and the
 * review shows it as a row of its own. A reference with no `display`, a
 * literal one, an untyped identifier, a type `fhir-r4` does not model, and a
 * type whose record needs more than a reference says (`ImpliedRecord.of`)
 * imply nothing, so it is left as the source wrote it. An implied record is keyed, so planning it mints nothing.
 *
 * @returns The section, or the `ParseError` an implied record's schema
 *   rejects it with
 */
const impliedSectionOf = (
  plannedSections: readonly PlannedSection[],
  mintId: () => string
): Either.Either<Option.Option<PlannedSection>, ParseResult.ParseError> => {
  const decodedEntries = plannedEntriesOf(plannedSections)
  return pipe(
    impliedTargetsOf(decodedEntries, referencePlanOf(decodedEntries)),
    Arr.dedupeWith((left, right) =>
      LogicalReference.equivalence(left.logicalReference, right.logicalReference)
    ),
    Arr.filterMap(({ logicalReference, display, referencingFullUrl }) =>
      Option.map(
        ImpliedRecord.of(logicalReference.resourceType, logicalReference.identifier[0], display),
        Either.map((resource): PlannedEntry => ({
          entry: {
            fullUrl: ImpliedRecord.fullUrlOf(
              referencingFullUrl,
              logicalReference.resourceType,
              logicalReference.identifier[0]
            ),
            resource,
          },
          plan: ResourcePlan.of(resource, mintId),
          origin: 'Implied',
        }))
      )
    ),
    Either.all,
    Either.map((impliedEntries) =>
      Option.map(
        Option.liftPredicate(impliedEntries, Arr.isNonEmptyReadonlyArray),
        (nonEmpty): PlannedSection => ({ title: IMPLIED_SECTION_TITLE, plannedEntries: nonEmpty })
      )
    )
  )
}

/**
 * The literal reference of the Patient of the set `reference` names, by the
 * set's reference plan: `None` for no reference, one to another type, or one
 * that does not resolve in the set.
 */
const patientReferenceIfInSet = (
  referencePlan: ReferencePlan.Type,
  reference: ReferenceType | null
): Option.Option<string> =>
  pipe(
    Option.fromNullable(reference),
    Option.filter(({ type }) => type === 'Patient'),
    Option.flatMap((patient) => ReferencePlan.literalReferenceIfResolved(referencePlan, patient))
  )

/** A prescription's `subject`, as it spells it, beside the literal reference of the Patient of the set it names. */
interface PrescriptionSubject {
  readonly subject: ReferenceType
  readonly patient: string
}

/**
 * For each keyed `MedicationRequest` of a set, by the literal reference it is
 * written under, the `subject` of each of its copies that names a Patient of
 * the set ({@link patientReferenceIfInSet}): empty for a request none of whose
 * copies does.
 *
 * @remarks
 * Only a keyed request is one a reference resolves to; a keyless one's
 * minted reference never is. A request has several copies when the set holds
 * it more than once under one key.
 */
type PrescriptionSubjects = ReadonlyMap<string, readonly PrescriptionSubject[]>

/** The {@link PrescriptionSubjects} of a set's planned records. */
const prescriptionSubjectsOf = (
  referencePlan: ReferencePlan.Type,
  plannedEntries: readonly PlannedEntry[]
): PrescriptionSubjects =>
  Arr.reduce(
    plannedEntries,
    new Map<string, readonly PrescriptionSubject[]>(),
    (prescriptionSubjects, { entry: { resource }, plan }) => {
      if (resource.resourceType !== 'MedicationRequest' || plan._tag !== 'Derived') {
        return prescriptionSubjects
      }
      const literalReference = ResourcePlan.literalReference(plan)
      const { subject } = resource
      return prescriptionSubjects.set(literalReference, [
        ...(prescriptionSubjects.get(literalReference) ?? []),
        ...Option.toArray(
          Option.map(patientReferenceIfInSet(referencePlan, subject), (patient) => ({
            subject,
            patient,
          }))
        ),
      ])
    }
  )

/**
 * The `subject` the prescriptions a dispense names agree it is for: `None`
 * unless every `authorizingPrescription` that resolves to a
 * `MedicationRequest` of the set has a copy naming a Patient of the set, at
 * least one does, and every copy that names one names the same Patient.
 *
 * @returns The first such `subject`, as its prescription spells it
 */
const prescriptionSubjectIfAgreed = (
  referencePlan: ReferencePlan.Type,
  prescriptionSubjects: PrescriptionSubjects,
  authorizingPrescriptions: readonly ReferenceType[]
): Option.Option<ReferenceType> =>
  pipe(
    authorizingPrescriptions,
    Arr.filterMap((prescription) =>
      Option.flatMapNullable(
        ReferencePlan.literalReferenceIfResolved(referencePlan, prescription),
        (literalReference) => prescriptionSubjects.get(literalReference)
      )
    ),
    Option.liftPredicate(Arr.every(Arr.isNonEmptyReadonlyArray)),
    Option.map(Arr.flatten),
    Option.flatMap(
      Arr.match({
        onEmpty: Option.none,
        onNonEmpty: ([first, ...rest]) =>
          Arr.every(rest, ({ patient }) => patient === first.patient)
            ? Option.some(first.subject)
            : Option.none(),
      })
    )
  )

/**
 * A detached record, a `MedicationDispense` with no `subject` filed on the
 * person its prescriptions agree it is for
 * ({@link prescriptionSubjectIfAgreed}), and any other record as it is.
 *
 * @remarks
 * A source may know who a prescription is for but not who one of its fills
 * was for (Shoppers' history feed names only the account, so its fills name
 * no one). Any `subject` a dispense has is the source's own statement of who
 * received the fill, so it is kept.
 */
const takeSubjectFromPrescription =
  (referencePlan: ReferencePlan.Type, prescriptionSubjects: PrescriptionSubjects) =>
  (record: DetachedResource.Type): DetachedResource.Type =>
    record.resourceType === 'MedicationDispense' && record.subject === null
      ? Option.match(
          prescriptionSubjectIfAgreed(
            referencePlan,
            prescriptionSubjects,
            record.authorizingPrescription
          ),
          { onNone: () => record, onSome: (subject) => ({ ...record, subject }) }
        )
      : record

/**
 * Adopt: each planned record of `plannedSections` given its plan's id, its
 * logical references `referencePlan` resolves made literal, after
 * `takeSubject`, keyed by its entry's `fullUrl` and titled by
 * {@link writtenReferenceTitle}, its origin kept.
 */
const adoptSections = (
  plannedSections: readonly PlannedSection[],
  referencePlan: ReferencePlan.Type,
  takeSubject: (record: DetachedResource.Type) => DetachedResource.Type
): readonly DecodedFile.Section[] => {
  const adoptEntry = adoptRecord(referencePlan)
  return plannedSections.map(({ title, plannedEntries }) => ({
    title,
    resources: plannedEntries.map(({ entry, plan, origin }) => ({
      key: entry.fullUrl,
      title: writtenReferenceTitle(plan, entry),
      resource: adoptEntry(takeSubject(entry.resource), plan.id),
      origin,
    })),
  }))
}

/**
 * A decode's sections adopted beside its notes: how the import stage makes a
 * file set's records the device's own, before it mints source files, links
 * and stamps.
 *
 * @param decoded - The set's sections and notes
 * @param mintId - Mints the id of a keyless record; random outside tests
 * @returns The adopted file, or the `ParseError` an implied record's schema
 *   rejects it with
 *
 * @remarks
 * As a FHIR server processes one transaction bundle, in five steps: plan
 * every record's id ({@link planSections}); imply the records the set's
 * references name and no record of the set is, in a section of their own,
 * last ({@link impliedSectionOf}); build the reference plan over every
 * record, the implied ones included ({@link referencePlanOf}); and adopt
 * each record ({@link adoptSections}), a `MedicationDispense` with no
 * `subject` first taking the `subject` of the prescriptions of the set it
 * names ({@link takeSubjectFromPrescription}). A logical reference resolves
 * when the set holds a keyed record it names by any of that record's
 * identifiers, whichever section holds it. One that names a record the set
 * does not hold and implies none, a keyless one, or an identifier two
 * records of the set share, stays logical, for the identity map.
 */
const adopt = (
  decoded: Pick<Type, 'sections' | 'notes'>,
  mintId: () => string = randomResourceId
): Either.Either<DecodedFile.DecodedFile, ParseResult.ParseError> => {
  const decodedSections = planSections(decoded.sections, mintId)
  return Either.map(impliedSectionOf(decodedSections, mintId), (impliedSection) => {
    const plannedSections = [...decodedSections, ...Option.toArray(impliedSection)]
    const plannedEntries = plannedEntriesOf(plannedSections)
    const referencePlan = referencePlanOf(plannedEntries)
    const takeSubject = takeSubjectFromPrescription(
      referencePlan,
      prescriptionSubjectsOf(referencePlan, plannedEntries)
    )
    return {
      sections: adoptSections(plannedSections, referencePlan, takeSubject),
      notes: decoded.notes,
    }
  })
}

export { adopt, namespaceKeys, unidentified, writtenReferenceTitle }
export type { Entry, PickedFileIdentity, Section, Type }
