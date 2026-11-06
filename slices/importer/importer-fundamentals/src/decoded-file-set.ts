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
import { Array as Arr, Option, pipe } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
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
 * re-decode and unique within the set; the import stage namespaces the review
 * key it becomes by the set's first picked file. A keyless record whose
 * `fullUrl` is an absolute URL (a FHIR server's `Binary`, at the server's URL
 * for it) is named by it: a reference or an `Attachment.url` spelling it
 * resolves to the record. It is not the record's `id`: `id: null` is what
 * marks a record detached.
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
 * with what it identifies itself as, and its sections and notes, each entry's
 * `fullUrl` as its format gave it.
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
              resourceType: derived.resourceType,
              identifier,
              literalReference: ResourcePlan.literalReference(derived),
            }))
        : [],
    Minted: () => [],
  })

/**
 * The `fullUrl` entry a planned record gives its set's reference plan: one
 * for a keyless record whose `fullUrl` is an absolute URL, resolving to the
 * literal reference the record is written under; none for any other.
 *
 * @remarks
 * How a record with no identifier is named, as a FHIR transaction bundle
 * names an entry by its `fullUrl`: a FHIR server's `Binary`, whose entry's
 * `fullUrl` is the server's URL for it. A keyed record is named by its
 * identifiers instead, and a `fullUrl` that is no URL (LifeLabs'
 * `<Type>/<key value>`, DICOM's fixed one per type) names nothing a
 * reference spells.
 */
const fullUrlEntriesOf = (
  plan: ResourcePlan.Type,
  { fullUrl }: Entry
): readonly ReferencePlan.FullUrlEntry[] =>
  ResourcePlan.match(plan, {
    Derived: () => [],
    Minted: (minted) =>
      pipe(
        Option.fromNullable(URL.parse(fullUrl)),
        Option.map((url) => ({
          fullUrl: url,
          literalReference: ResourcePlan.literalReference(minted),
        })),
        Option.toArray
      ),
  })

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
  plannedEntries: readonly { readonly entry: Entry; readonly plan: ResourcePlan.Type }[]
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
 * A decode's sections adopted beside its notes: how the import stage makes a
 * file set's records the device's own, before it mints source files, links
 * and stamps. Each adopted row is keyed by its entry's `fullUrl` and titled
 * by {@link writtenReferenceTitle}.
 *
 * @param decoded - The set's sections and notes
 * @param mintId - Mints the id of a keyless record; random outside tests
 *
 * @remarks
 * As a FHIR server processes one transaction bundle: every record's plan
 * (`ResourcePlan.of`) is decided first, a keyed record's id derived from its
 * key and a keyless one's minted, in entry order; the set's reference plan is
 * built from the keyed records' plans and qualified identifiers, and from the
 * keyless records' absolute `fullUrl`s; then each record is adopted under its
 * plan's id, a logical reference resolving when the set holds a keyed record
 * it names by any of that record's identifiers, whichever section holds it,
 * and a literal reference or an `Attachment.url` when it spells a keyless
 * record's `fullUrl`. A logical one that names a record the set does not
 * hold, a keyless one, or an identifier two records of the set share, stays
 * logical, for the identity map; a literal one that names no entry keeps its
 * literal. Before it is adopted, a `MedicationDispense`
 * with no `subject` takes the `subject` of the prescriptions of the set it
 * names ({@link takeSubjectFromPrescription}).
 */
const adopt = (
  decoded: Pick<Type, 'sections' | 'notes'>,
  mintId: () => string = randomResourceId
): DecodedFile.DecodedFile => {
  const plannedSections = decoded.sections.map(({ title, entries }) => ({
    title,
    plannedEntries: entries.map((entry) => ({
      entry,
      plan: ResourcePlan.of(entry.resource, mintId),
    })),
  }))
  const setEntries = plannedSections.flatMap(({ plannedEntries }) => plannedEntries)
  const referencePlan = ReferencePlan.of(
    setEntries.flatMap(({ entry, plan }) => referencePlanEntriesOf(plan, entry.resource)),
    setEntries.flatMap(({ entry, plan }) => fullUrlEntriesOf(plan, entry))
  )
  const takeSubject = takeSubjectFromPrescription(
    referencePlan,
    prescriptionSubjectsOf(referencePlan, setEntries)
  )
  const adoptEntry = adoptRecord(referencePlan)
  return {
    sections: plannedSections.map(({ title, plannedEntries }) => ({
      title,
      resources: plannedEntries.map(({ entry, plan }) => ({
        key: entry.fullUrl,
        title: writtenReferenceTitle(plan, entry),
        resource: adoptEntry(takeSubject(entry.resource), plan.id),
      })),
    })),
    notes: decoded.notes,
  }
}

export { adopt, unidentified, writtenReferenceTitle }
export type { Entry, PickedFileIdentity, Section, Type }
