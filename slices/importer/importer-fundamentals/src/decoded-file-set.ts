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
import { Array as Arr, Effect, Either, Option, type ParseResult, pipe } from 'effect'

import type * as AdoptedFileSet from './adopted-file-set.ts'
import type * as FileSetRecord from './file-set-record.ts'
import * as ImpliedRecord from './implied-record.ts'
import type * as PickedFile from './picked-file.ts'
import * as ResourcePlan from './resource-plan.ts'
import type * as ReviewRow from './review-row.ts'
import * as Section from './section.ts'
import * as SectionedList from './sectioned-list.ts'

/**
 * A record's review title, the one title every record of a set is reviewed
 * under, read off its plan: for a keyed record, the literal reference the
 * import stage writes it under, `<Type>/<id>`, its derived id; for a keyless
 * record, whose minted id changes on every re-decode, its type and its review
 * key, `<Type> (<reviewKey>)`.
 *
 * @param plan - The plan of the record
 * @param reviewKey - The record's review key
 */
const writtenReferenceTitle = (plan: ResourcePlan.Type, reviewKey: string): string =>
  ResourcePlan.match(plan, {
    Derived: ResourcePlan.literalReference,
    Minted: ({ resourceType }) => `${resourceType} (${reviewKey})`,
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
 * One file set's decode, exactly as a format's `decodeFileSet` returns it: its
 * picked files, in the order they were picked, each with what it identifies
 * itself as, its records in sections, each under its local key, and its notes.
 *
 * @remarks
 * A decoder builds one section per report, study or response URL: LifeLabs
 * one per report, DICOM one per study, the HAR importer one per response URL.
 * Each decoder writes or detaches its records itself, so a section carries no
 * source base URL or system: everything the import stage needs to adopt a
 * record is on the record. The section listing a set's source files is built
 * by the import stage, never decoded.
 */
interface Type {
  readonly pickedFiles: Arr.NonEmptyReadonlyArray<PickedFileIdentity>
  readonly sectionedList: SectionedList.Type<FileSetRecord.Type>
  readonly notes: readonly string[]
}

/** `pickedFile`, identifying as nothing: a picked file of a format whose files do not name themselves. */
const unidentified = (pickedFile: PickedFile.Type): PickedFileIdentity => ({
  pickedFile,
  identifiedAs: Option.none(),
})

/**
 * The entries a placed record gives its set's reference plan: one for each
 * qualified identifier of a keyed record, its key and every other, each
 * resolving to the literal reference the record is written under; none for a
 * keyless record, which no identifier names.
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
 * One record of a set beside its plan, decided before any record of the set is
 * adopted, and whether the set's references imply it (no decoder read it).
 */
interface PlacedRecord {
  readonly record: FileSetRecord.Type
  readonly plan: ResourcePlan.Type
  readonly isImplied: boolean
}

/**
 * The source URL entry a placed record gives its set's reference plan: one
 * for a keyless record a source served at a URL (`FileSetRecord.sourceUrl`),
 * resolving to the literal reference it is written under; none for a keyed
 * record, which its identifiers name, or one with no source URL.
 */
const sourceUrlEntryOf = ({
  record,
  plan,
}: PlacedRecord): Option.Option<ReferencePlan.SourceUrlEntry> =>
  ResourcePlan.match(plan, {
    Derived: () => Option.none(),
    Minted: (minted) =>
      Option.map(record.sourceUrl, (sourceUrl) => ({
        sourceUrl,
        literalReference: ResourcePlan.literalReference(minted),
      })),
  })

/**
 * The reference plan of a set's placed records: each record's entries by
 * identifier ({@link referencePlanEntriesOf}) and by source URL
 * ({@link sourceUrlEntryOf}).
 */
const referencePlanOf = (placedRecords: readonly PlacedRecord[]): ReferencePlan.Type =>
  ReferencePlan.of(
    placedRecords.flatMap(({ record, plan }) => referencePlanEntriesOf(plan, record.resource)),
    Arr.filterMap(placedRecords, sourceUrlEntryOf)
  )

/** The title of the section a set's implied records are reviewed in, the last of its sections. */
const IMPLIED_SECTION_TITLE = 'Implied records'

/**
 * Plan ids: each decoded record beside its plan (`ResourcePlan.make`), a keyed
 * record's id derived from its key and a keyless one's minted, in record
 * order, none implied.
 *
 * @remarks
 * As a FHIR server processing a transaction bundle first decides the id
 * every entry is stored under, before it rewrites any reference between them.
 */
const planRecords = (
  sectionedList: SectionedList.Type<FileSetRecord.Type>,
  mintId: () => string
): SectionedList.Type<PlacedRecord> =>
  SectionedList.map(sectionedList, (record): PlacedRecord => ({
    record,
    plan: ResourcePlan.make(record.resource, mintId),
    isImplied: false,
  }))

/**
 * A logical reference of a set to a record no record of the set is, beside
 * what the reference says of it, its `display`, and the local key of the
 * record holding it.
 */
interface ImpliedTarget {
  readonly logicalReference: LogicalReference.Type
  readonly display: string
  readonly referencingLocalKey: string
}

/**
 * Every reference of `placedRecords`, at any depth, in record order, that
 * names a record the set does not hold: a logical reference
 * (`LogicalReference.tryFromReference`) with a `display` that no record of the
 * set holds by any identifier (`ReferencePlan.holds` of `heldPlan`).
 */
const impliedTargetsOf = (
  placedRecords: readonly PlacedRecord[],
  heldPlan: ReferencePlan.Type
): readonly ImpliedTarget[] =>
  pipe(
    placedRecords,
    Arr.flatMap(({ record }) =>
      Arr.filterMap(ResourceReferences.collect(record.resource), ({ reference }) =>
        Option.all({
          logicalReference: LogicalReference.tryFromReference(reference),
          display: Option.fromNullable(reference.display),
          referencingLocalKey: Option.some(record.localKey),
        })
      )
    ),
    Arr.filter(({ logicalReference }) => !ReferencePlan.holds(heldPlan, logicalReference))
  )

/**
 * Imply: the section of the records the references of `decodedPlaced`
 * imply, `None` when they imply none. Each record is one a logical reference
 * names and no record of the set holds ({@link impliedTargetsOf}), built for
 * its type by `ImpliedRecord.tryFromLogicalReference`, keyed by the
 * reference's identifier and named by its display, under a local key read off
 * the record holding it (`ImpliedRecord.localKeyOf`), and implied. Its plan is
 * the reference's own (`ResourcePlan.derived`): an implied record is keyed by
 * the identifier of the reference that implies it. One record covers every
 * reference to one target: the first to name it, in record order, is the one
 * it is built from.
 *
 * @remarks
 * A reference names a record the import never saw: a Rexall prescriber
 * carebook names as `Practitioner/<id>` and never serves, or a provider a
 * source knows only by a printed name it keys in its own name system. Once
 * the set holds the record, every reference to it resolves to it, and the
 * review shows it as a row of its own. A reference with no `display`, a
 * literal one, an untyped identifier, a type `fhir-r4` does not model, and a
 * type whose record needs more than a reference says
 * (`ImpliedRecord.tryFromLogicalReference`) imply nothing, so it is left as
 * the source wrote it.
 *
 * @returns The section, or the `ParseError` an implied record's schema
 *   rejects it with
 */
const impliedSectionOf = (
  decodedPlaced: readonly PlacedRecord[]
): Either.Either<Option.Option<Section.Type<PlacedRecord>>, ParseResult.ParseError> =>
  pipe(
    impliedTargetsOf(decodedPlaced, referencePlanOf(decodedPlaced)),
    Arr.dedupeWith((left, right) =>
      LogicalReference.equivalence(left.logicalReference, right.logicalReference)
    ),
    Arr.filterMap(({ logicalReference, display, referencingLocalKey }) =>
      Option.map(
        ImpliedRecord.tryFromLogicalReference(logicalReference, display),
        Either.map((resource): PlacedRecord => ({
          record: {
            localKey: ImpliedRecord.localKeyOf(referencingLocalKey, logicalReference),
            resource,
            sourceUrl: Option.none(),
          },
          plan: ResourcePlan.derived(resource.resourceType, logicalReference.identifier[0]),
          isImplied: true,
        }))
      )
    ),
    Either.all,
    Either.map((implied) =>
      Option.map(Option.liftPredicate(implied, Arr.isNonEmptyReadonlyArray), (nonEmptyImplied) =>
        Section.make(IMPLIED_SECTION_TITLE, nonEmptyImplied)
      )
    )
  )

/**
 * The literal reference of the Patient of the set `reference` names, by the
 * reference plan in force: `None` for no reference, one to another type, or
 * one that does not resolve in the set.
 */
const patientReferenceIfInSet = (
  reference: ReferenceType | null
): Effect.Effect<Option.Option<string>, never, ReferencePlan.InForce> =>
  Effect.map(ReferencePlan.InForce, (referencePlan) =>
    pipe(
      Option.fromNullable(reference),
      Option.filter(({ type }) => type === 'Patient'),
      Option.flatMap((patient) => ReferencePlan.literalReferenceIfResolved(referencePlan, patient))
    )
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

/** The {@link PrescriptionSubjects} of a set's placed records. */
const prescriptionSubjectsOf = (
  placedRecords: readonly PlacedRecord[]
): Effect.Effect<PrescriptionSubjects, never, ReferencePlan.InForce> =>
  Effect.reduce(
    placedRecords,
    new Map<string, readonly PrescriptionSubject[]>(),
    (prescriptionSubjects, { record: { resource }, plan }) => {
      if (resource.resourceType !== 'MedicationRequest' || plan._tag !== 'Derived') {
        return Effect.succeed(prescriptionSubjects)
      }
      const literalReference = ResourcePlan.literalReference(plan)
      const { subject } = resource
      return Effect.map(patientReferenceIfInSet(subject), (patient) =>
        prescriptionSubjects.set(literalReference, [
          ...(prescriptionSubjects.get(literalReference) ?? []),
          ...Option.toArray(Option.map(patient, (literal) => ({ subject, patient: literal }))),
        ])
      )
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
  prescriptionSubjects: PrescriptionSubjects,
  authorizingPrescriptions: readonly ReferenceType[]
): Effect.Effect<Option.Option<ReferenceType>, never, ReferencePlan.InForce> =>
  Effect.map(ReferencePlan.InForce, (referencePlan) =>
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
  (prescriptionSubjects: PrescriptionSubjects) =>
  (
    record: DetachedResource.Type
  ): Effect.Effect<DetachedResource.Type, never, ReferencePlan.InForce> =>
    record.resourceType === 'MedicationDispense' && record.subject === null
      ? Effect.map(
          prescriptionSubjectIfAgreed(prescriptionSubjects, record.authorizingPrescription),
          Option.match({ onNone: () => record, onSome: (subject) => ({ ...record, subject }) })
        )
      : Effect.succeed(record)

/**
 * File each `MedicationDispense` of `allPlaced` with no `subject` on the person
 * its prescriptions agree it is for ({@link takeSubjectFromPrescription}),
 * by the reference plan in force.
 */
const fileDispenses = (
  allPlaced: SectionedList.Type<PlacedRecord>
): Effect.Effect<SectionedList.Type<PlacedRecord>, never, ReferencePlan.InForce> =>
  Effect.flatMap(prescriptionSubjectsOf(SectionedList.rows(allPlaced)), (prescriptionSubjects) =>
    SectionedList.forEach(allPlaced, (placed) =>
      Effect.map(
        takeSubjectFromPrescription(prescriptionSubjects)(placed.record.resource),
        (resource): PlacedRecord => ({ ...placed, record: { ...placed.record, resource } })
      )
    )
  )

/**
 * Every record of a set as the import holds it before anything is chosen for
 * it: each decoded record beside its plan, then the records the set's
 * references imply, with each `MedicationDispense` with no `subject` filed
 * on its prescriptions' Patient.
 *
 * @param sectionedList - The set's records, as its format decoded them
 * @param mintId - Mints the id of a keyless record; random outside tests
 * @returns The placed records, or the `ParseError` an implied record's
 *   schema rejects it with
 *
 * @remarks
 * Three steps: plan every record's id ({@link planRecords}); imply the
 * records the set's references name and no record of the set is, in a
 * section of their own, last ({@link impliedSectionOf}); and, with the
 * reference plan over every record in force ({@link referencePlanOf}), file
 * each dispense with no `subject` ({@link fileDispenses}). Both the import
 * stage's {@link adopt} and the import plan read a set's records through it.
 */
const placedRecordsOf = (
  sectionedList: SectionedList.Type<FileSetRecord.Type>,
  mintId: () => string
): Effect.Effect<SectionedList.Type<PlacedRecord>, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const decodedPlaced = planRecords(sectionedList, mintId)
    const impliedPlaced = yield* impliedSectionOf(SectionedList.rows(decodedPlaced))
    const allPlaced = Option.match(impliedPlaced, {
      onNone: () => decodedPlaced,
      onSome: (section) => SectionedList.append(decodedPlaced, section),
    })
    return yield* fileDispenses(allPlaced).pipe(
      Effect.provideService(ReferencePlan.InForce, referencePlanOf(SectionedList.rows(allPlaced)))
    )
  })

/**
 * Adopt: each placed record of `allPlaced` given its plan's id, its logical
 * references the reference plan in force resolves made literal, its row
 * keyed by its review key (the set's `keyPrefix` and its local key), titled
 * by {@link writtenReferenceTitle} and saying whether it is implied.
 */
const adoptRecords = (
  allPlaced: SectionedList.Type<PlacedRecord>,
  keyPrefix: string
): Effect.Effect<SectionedList.Type<ReviewRow.Type>, never, ReferencePlan.InForce> =>
  SectionedList.forEach(allPlaced, ({ record, plan, isImplied }) => {
    const reviewKey = `${keyPrefix}${record.localKey}`
    return Effect.map(adoptRecord(record.resource, plan.id), (resource): ReviewRow.Type => ({
      reviewKey,
      title: writtenReferenceTitle(plan, reviewKey),
      isImplied,
      resource,
    }))
  })

/**
 * A file set's records adopted beside its notes: how the import stage makes a
 * file set's records the device's own, before it mints source files, links
 * and stamps.
 *
 * @param decoded - The set's records and notes, as its format decoded them
 * @param keyPrefix - What every review key of the set starts with
 * @param mintId - Mints the id of a keyless record; random outside tests
 * @returns The adopted file set, or the `ParseError` an implied record's schema
 *   rejects it with
 *
 * @remarks
 * As a FHIR server processes one transaction bundle: place every record
 * ({@link placedRecordsOf}: each record's id planned, the records the set's
 * references imply added, each `MedicationDispense` with no `subject` filed
 * on the Patient of the prescriptions of the set it names); build the
 * reference plan over every record, the implied ones included
 * ({@link referencePlanOf}), and put it in force (`ReferencePlan.InForce`);
 * and adopt each record ({@link adoptRecords}). A logical reference resolves
 * when the set holds a keyed record it names by any of that record's
 * identifiers, whichever section holds it. One that names a record the set
 * does not hold and implies none, a keyless one, or an identifier two
 * records of the set share, stays logical, for the identity map. A literal
 * reference or an `Attachment.url` resolves when it spells the source URL of
 * a keyless record of the set ({@link sourceUrlEntryOf}): a `Binary` a
 * FHIR server served, by the server's URL for it.
 *
 * Each row's review key is `keyPrefix` before the record's local key. The
 * import stage passes the prefix of the set's first picked file
 * (`FormatDecode.keyPrefix`), so one set's keys cannot collide with
 * another's once their sections are merged.
 */
const adopt = (
  decoded: Pick<Type, 'sectionedList' | 'notes'>,
  keyPrefix: string,
  mintId: () => string = randomResourceId
): Effect.Effect<AdoptedFileSet.Type, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const allPlaced = yield* placedRecordsOf(decoded.sectionedList, mintId)
    const sectionedList = yield* adoptRecords(allPlaced, keyPrefix).pipe(
      Effect.provideService(ReferencePlan.InForce, referencePlanOf(SectionedList.rows(allPlaced)))
    )
    return { sectionedList, notes: decoded.notes }
  })

export { adopt, placedRecordsOf, unidentified, writtenReferenceTitle }
export type { PickedFileIdentity, PlacedRecord, Type }
