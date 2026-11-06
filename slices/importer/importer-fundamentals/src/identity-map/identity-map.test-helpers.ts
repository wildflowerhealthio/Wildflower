/**
 * What the identity-map tests share: wire builders for the shapes the Shoppers
 * and LifeLabs decodes emit, generated decoded files over a small pool of
 * identities, and the wire-side oracles the properties compare by.
 *
 * @packageDocumentation
 */

import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  FhirResourceSchema,
  MedicationRequest,
  Observation,
  Patient,
  Practitioner,
  type FhirResource,
  type FhirResourceWithId,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Arbitrary, Array, Effect, FastCheck as fc, HashMap, Schema, TestContext } from 'effect'

import type * as DecodedFile from '../decoded-file.ts'
import type * as Row from '../row.ts'
import * as Sectioned from '../sectioned.ts'
import * as FileResolution from './file-resolution.ts'
import * as LinkChoice from './link-choice.ts'
import * as LinkPlan from './link-plan.ts'
import type * as LinkableResource from './linkable-resource.ts'
import * as MentionLinkChoiceSet from './mention-link-choice-set.ts'
import type * as ReferentLinkChoiceSet from './referent-link-choice-set.ts'
import * as Referent from './referent.ts'
import * as UnlinkedMention from './unlinked-mention.ts'

const SOURCE_PATIENT = 'https://source.example/patient-id'
const SOURCE_PRACTITIONER = 'https://source.example/practitioner-id'
const PRACTITIONER_NAME = 'https://source.example/practitioner-name'
const CUSTOMER = 'https://source.example/customer-id'
const DEVICE = 'https://device.example/id'
const ABSOLUTE = 'https://elsewhere.example/fhir/Patient/1'

/**
 * `effect` run on a `TestClock` standing at the epoch, so nothing a test
 * asserts depends on the day it runs; throws its failure.
 */
const runOnTestClock = <A, E>(effect: Effect.Effect<A, E>): A =>
  Effect.runSync(Effect.provide(effect, TestContext.TestContext))

/**
 * A batch's `files` resolved on `linkChoices`, and on `byMention`
 * when given, as `importer-core`'s `resolveMentions` resolves a batch's
 * formats: one link plan over the whole batch, the mention link choices laid
 * on it, every file resolved on it in the order given, and the batch's linked
 * records off the plan.
 */
const resolveAcross = (
  files: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>,
  linkChoices: ReferentLinkChoiceSet.Type,
  byMention: MentionLinkChoiceSet.Type = MentionLinkChoiceSet.empty
): Effect.Effect<
  {
    readonly resolvedFiles: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>
    readonly linkedRecords: readonly Row.Type<FhirResourceWithId>[]
  },
  Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice
> =>
  Effect.map(
    Effect.map(LinkPlan.make(files, linkChoices), (plan) =>
      LinkPlan.withMentionLinkChoiceSet(plan, byMention)
    ),
    (plan) => ({
      resolvedFiles: Array.map(files, FileResolution.resolveFile(plan)),
      linkedRecords: FileResolution.linkedRecords(plan),
    })
  )

/** {@link resolveAcross} over `files`, run on the test clock. */
const resolveAcrossOnTestClock = (
  files: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>,
  linkChoices: ReferentLinkChoiceSet.Type,
  byMention: MentionLinkChoiceSet.Type = MentionLinkChoiceSet.empty
): Effect.Effect.Success<ReturnType<typeof resolveAcross>> =>
  runOnTestClock(resolveAcross(files, linkChoices, byMention))

/** The one resolved file of a batch of one `file`, run on the test clock. */
const resolveOnTestClock = (
  file: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoiceSet.Type,
  byMention: MentionLinkChoiceSet.Type = MentionLinkChoiceSet.empty
): DecodedFile.DecodedFile =>
  Array.headNonEmpty(resolveAcrossOnTestClock(Array.of(file), linkChoices, byMention).resolvedFiles)

/**
 * What the referent links leave unlinked in each resource of a batch of one
 * `file`, as decoded, in review order (`UnlinkedMention.leftByReferentLinks`
 * on the plan, with `byMention` laid on it when given), run on the test
 * clock.
 */
const leftByReferentLinksOnTestClock = (
  file: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoiceSet.Type,
  byMention: MentionLinkChoiceSet.Type = MentionLinkChoiceSet.empty
): readonly UnlinkedMention.Type[] => {
  const plan = runOnTestClock(
    Effect.map(LinkPlan.make([file], linkChoices), (onReferents) =>
      LinkPlan.withMentionLinkChoiceSet(onReferents, byMention)
    )
  )
  return Sectioned.entries(file).flatMap(({ key, resource }) =>
    UnlinkedMention.leftByReferentLinks(plan, key, resource)
  )
}

/** `Referent.discover` over a batch of one `file`, run on the test clock. */
const discoverOnTestClock = (file: DecodedFile.DecodedFile): readonly Referent.Type[] =>
  runOnTestClock(Referent.discover([file]))

const encodeResource = Schema.encodeSync(FhirResourceSchema)

/** A resource as its wire JSON text: what "byte-identical" compares. */
const wireOf = (resource: FhirResource): string => JSON.stringify(encodeResource(resource))

/** A decoded file as wire JSON text, keys and titles included. */
const fileWireOf = (file: DecodedFile.DecodedFile): string =>
  JSON.stringify(
    file.sections.map((section) => ({
      title: section.title,
      entries: section.entries.map((entry) => [entry.key, entry.title, wireOf(entry.resource)]),
    }))
  )

const WireIdentifier = Schema.Struct({
  system: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
})
const WireReference = Schema.Struct({
  reference: Schema.optional(Schema.String),
  identifier: Schema.optional(WireIdentifier),
  type: Schema.optional(Schema.String),
})
/** A `performer` on the wire: a reference, or an `actor` holding one. */
const WirePerformer = Schema.Union(Schema.Struct({ actor: WireReference }), WireReference)

/**
 * The fields of a resource's wire form the identity map reads, decoded loosely
 * and apart from the decoded-side code, as the properties' oracle.
 */
const WireResource = Schema.Struct({
  resourceType: Schema.String,
  identifier: Schema.optional(Schema.Array(WireIdentifier)),
  name: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))),
  subject: Schema.optional(WireReference),
  requester: Schema.optional(WireReference),
  performer: Schema.optional(Schema.Union(WirePerformer, Schema.Array(WirePerformer))),
})

/** `resource`'s wire form, read through {@link WireResource}. */
const wireFieldsOf = (resource: FhirResource): typeof WireResource.Type =>
  Schema.decodeUnknownSync(WireResource)(encodeResource(resource))

interface PatientArgs {
  readonly id: string
  readonly system?: string
  readonly value?: string
  readonly family?: string | null
  readonly given?: string | null
  readonly birthDate?: string | null
}

/** A decoded `Patient` keyed by `value` under `system`, named and dated when given. */
const patient = ({
  id,
  system = SOURCE_PATIENT,
  value = id,
  family = 'Banks',
  given = 'Tyra',
  birthDate = '1990-01-02',
}: PatientArgs): Patient.Type & { readonly id: string } =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id,
    identifier: [{ system, value }],
    name: family === null ? [] : [{ family, given: given === null ? [] : [given] }],
    ...(birthDate === null ? {} : { birthDate }),
  })

/** A decoded `Practitioner` named only by printed `text`, as LifeLabs writes one. */
const practitioner = (
  id: string,
  text: string,
  system = SOURCE_PRACTITIONER
): Practitioner.Type & { readonly id: string } =>
  Schema.decodeUnknownSync(withMandatoryId(Practitioner.Schema))({
    resourceType: 'Practitioner',
    id,
    identifier: [{ system, value: id }],
    name: [{ text }],
  })

/** A Shoppers-style status or request `subject`: the literal, with the adopted source id. */
const literalSubject = (id: string): object => ({
  reference: `Patient/${id}`,
  identifier: { system: SOURCE_PATIENT, value: id },
})

/** An account `subject`: a logical reference to a `Patient` by the account's id alone. */
const customerSubject = (customerId: string): object => ({
  type: 'Patient',
  identifier: { system: CUSTOMER, value: customerId },
})

/** A Shoppers-style `requester`: a logical reference to a prescriber known only by name. */
const namedRequester = (name: string): object => ({
  type: 'Practitioner',
  identifier: { system: PRACTITIONER_NAME, value: name },
  display: name,
})

/** An identifier-only reference that states no type: a logical reference to nothing the map can name. */
const untypedSubject = (value: string): object => ({
  identifier: { system: SOURCE_PATIENT, value },
})

/** A decoded `MedicationRequest` with the given `subject` and optional `requester`. */
const request = (id: string, subject: object, requester?: object): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject,
    ...(requester === undefined ? {} : { requester }),
    priorPrescription: { identifier: { system: 'https://source.example/rx-number', value: '7' } },
  })

/** A decoded `Observation` with an optional `subject` and `performer`s. */
const observation = (
  id: string,
  subject?: object,
  performer: readonly object[] = []
): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Observation.Schema))({
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { text: 'Glucose' },
    ...(subject === undefined ? {} : { subject }),
    performer,
  })

/** A decoded file of one section, keyed `k-<index>`. */
const fileOf = (...resources: readonly FhirResourceWithId[]): DecodedFile.DecodedFile => ({
  sections: [
    {
      title: 'Resources',
      entries: resources.map((resource, index) => ({
        key: `k-${index}`,
        title: `${resource.resourceType}/${resource.id}`,
        resource,
        origin: 'Decoded',
      })),
    },
  ],
  notes: [],
})

/** A stored resource: the decoded one with its `id` known to be set. */
const storedOf = (resource: FhirResourceWithId): LinkableResource.WithId => {
  if (resource.resourceType !== 'Patient' && resource.resourceType !== 'Practitioner') {
    throw new Error('a stored resource is a Patient or Practitioner')
  }
  return resource
}

const POOL = ['a', 'b'] as const
const NAMES = ['Dr. A Smith', 'Dr. B Jones'] as const

// The stored resources a generated map links to; under `DEVICE`, so no pool key names one.
const STORED_TYRA = storedOf(patient({ id: 's-1', system: DEVICE }))
const STORED_JAN = storedOf(
  patient({ id: 's-2', system: DEVICE, family: 'Doe', given: 'Jan', birthDate: null })
)
const STORED_SMITH = storedOf(practitioner('sp-1', 'Dr. A Smith', DEVICE))
const STORED: readonly LinkableResource.WithId[] = [STORED_TYRA, STORED_JAN, STORED_SMITH]

/** Every referent key a generated file can hold. */
const POOL_KEYS: readonly string[] = [
  ...POOL.map((value) => JSON.stringify(['Patient', SOURCE_PATIENT, value])),
  ...POOL.map((value) => JSON.stringify(['Practitioner', SOURCE_PRACTITIONER, `pr-${value}`])),
]

const valueArbitrary = fc.constantFrom(...POOL)

const subjectArbitrary: fc.Arbitrary<object | undefined> = fc.oneof(
  valueArbitrary.map((value) => literalSubject(value)),
  valueArbitrary.map((value) => customerSubject(`c-${value}`)),
  valueArbitrary.map((value) => ({
    type: 'Patient',
    identifier: { system: SOURCE_PATIENT, value },
  })),
  valueArbitrary.map(untypedSubject),
  fc.constant({ reference: ABSOLUTE }),
  fc.constant(undefined)
)

const performerArbitrary: fc.Arbitrary<object> = fc.oneof(
  fc.constantFrom(...NAMES).map(namedRequester),
  valueArbitrary.map((value) => ({ reference: `Practitioner/pr-${value}` })),
  fc.constant({ display: 'LifeLabs · 100 International Blvd' })
)

/** Generated resources with no reference into the pool, so no map entry can touch them. */
const unrelatedArbitrary: fc.Arbitrary<FhirResourceWithId> = fc
  .tuple(Arbitrary.make(Observation.Schema), fc.uuid())
  .map(([generated, id]): FhirResourceWithId => ({ ...generated, id, contained: [] }))

/** A generated resource, over the pool of identities. */
const resourceArbitrary: fc.Arbitrary<FhirResourceWithId> = fc.oneof(
  fc
    .record({
      value: valueArbitrary,
      family: fc.constantFrom('Banks', null),
      birthDate: fc.constantFrom('1990-01-02', null),
    })
    .map(({ value, family, birthDate }) => patient({ id: value, family, birthDate })),
  fc
    .tuple(valueArbitrary, fc.constantFrom(...NAMES))
    .map(([value, name]) => practitioner(`pr-${value}`, name)),
  fc
    .tuple(fc.uuid(), subjectArbitrary, fc.array(performerArbitrary, { maxLength: 2 }))
    .map(([id, subject, performer]) => observation(id, subject, performer)),
  fc
    .tuple(fc.uuid(), subjectArbitrary, fc.option(performerArbitrary, { nil: undefined }))
    .map(([id, subject, requester]) => request(id, subject ?? customerSubject('c-a'), requester)),
  unrelatedArbitrary
)

/** A generated decoded file over the pool, in one or two sections. */
const fileArbitrary: fc.Arbitrary<DecodedFile.DecodedFile> = fc
  .array(resourceArbitrary, { maxLength: 8 })
  .chain((resources) =>
    fc.integer({ min: 0, max: resources.length }).map((split) => {
      const file = fileOf(...resources)
      const entries = file.sections.flatMap((section) => section.entries)
      return {
        ...file,
        sections: [
          { title: 'First', entries: entries.slice(0, split) },
          { title: 'Second', entries: entries.slice(split) },
        ],
      }
    })
  )

const anyChoiceArbitrary: fc.Arbitrary<LinkChoice.Type> = fc.oneof(
  fc.constant(LinkChoice.CreateResource()),
  fc.constantFrom(...STORED).map((resource) => LinkChoice.LinkToStoredResource({ resource })),
  fc.constantFrom(...STORED).map((resource) => LinkChoice.UpdateStoredResource({ resource }))
)

/** Generated choices over the pool's keys, any choice on any referent, impossible ones included. */
const anyChoicesArbitrary: fc.Arbitrary<ReferentLinkChoiceSet.Type> = fc
  .array(fc.tuple(fc.constantFrom(...POOL_KEYS), anyChoiceArbitrary), {
    maxLength: POOL_KEYS.length,
  })
  .map(HashMap.fromIterable)

/** The stored copy of `decoded` a re-import finds: the same resource, carrying one identifier more, the device's own. */
const storedCopyOf = (decoded: LinkableResource.WithId): LinkableResource.WithId => ({
  ...decoded,
  identifier: [
    ...decoded.identifier,
    {
      id: null,
      extension: [],
      assigner: null,
      period: null,
      system: new URL(DEVICE),
      type: null,
      use: null,
      value: decoded.id,
    },
  ],
})

/** A choice `referent` can take. */
const choiceForArbitrary = (referent: Referent.Type): fc.Arbitrary<LinkChoice.Type> =>
  fc.oneof(
    fc.constant(LinkChoice.CreateResource()),
    fc.constant(LinkChoice.UpdateStoredResource({ resource: storedCopyOf(referent.resource) })),
    fc
      .constantFrom(
        ...STORED.filter((stored) => stored.resourceType === referent.logicalReference.resourceType)
      )
      .map((resource) => LinkChoice.LinkToStoredResource({ resource }))
  )

/** Generated choices every referent of `file` can take, or none for some. */
const choicesForArbitrary = (
  file: DecodedFile.DecodedFile
): fc.Arbitrary<ReferentLinkChoiceSet.Type> => {
  const referents = discoverOnTestClock(file)
  return fc
    .tuple(
      ...referents.map((referent) =>
        fc
          .option(choiceForArbitrary(referent), { nil: undefined })
          .map((choice) => ({ referentKey: Referent.key(referent), choice }))
      )
    )
    .map((made) =>
      HashMap.fromIterable(
        made.flatMap(({ referentKey, choice }) =>
          choice === undefined ? [] : [[referentKey, choice] as const]
        )
      )
    )
}

/** A generated decoded file and choices its referents can take. */
const fileWithChoicesArbitrary: fc.Arbitrary<{
  readonly file: DecodedFile.DecodedFile
  readonly choices: ReferentLinkChoiceSet.Type
}> = fileArbitrary.chain((file) => choicesForArbitrary(file).map((choices) => ({ file, choices })))

export {
  ABSOLUTE,
  CUSTOMER,
  DEVICE,
  SOURCE_PATIENT,
  PRACTITIONER_NAME,
  SOURCE_PRACTITIONER,
  STORED,
  STORED_JAN,
  STORED_SMITH,
  STORED_TYRA,
  anyChoicesArbitrary,
  resolveAcrossOnTestClock,
  resolveOnTestClock,
  customerSubject,
  discoverOnTestClock,
  fileArbitrary,
  fileOf,
  fileWireOf,
  fileWithChoicesArbitrary,
  leftByReferentLinksOnTestClock,
  literalSubject,
  resolveAcross,
  namedRequester,
  observation,
  patient,
  practitioner,
  request,
  runOnTestClock,
  storedOf,
  unrelatedArbitrary,
  untypedSubject,
  wireFieldsOf,
  wireOf,
}
