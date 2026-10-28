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
import {
  Arbitrary,
  Array,
  Effect,
  FastCheck as fc,
  HashMap,
  Option,
  Schema,
  TestContext,
} from 'effect'

import type * as DecodedFile from '../decoded-file.ts'
import * as FileResolution from './file-resolution.ts'
import * as LinkChoice from './link-choice.ts'
import * as LinkPlan from './link-plan.ts'
import * as LinkableLogicalReference from './linkable-logical-reference.ts'
import * as LinkableResource from './linkable-resource.ts'
import type * as ReferentLinkChoices from './referent-link-choices.ts'
import * as Referent from './referent.ts'

const SOURCE_PATIENT = 'https://source.example/patient-id'
const SOURCE_PRACTITIONER = 'https://source.example/practitioner-id'
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
 * A batch's `files` resolved on `linkChoices` as `importer-core`'s
 * `resolveMentions` resolves a batch's formats: one link plan over the whole
 * batch, every file resolved on it in the order given, and the batch's linked
 * records off the plan.
 */
const resolveAcross = (
  files: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>,
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect<
  {
    readonly resolvedFiles: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>
    readonly linked: readonly FileResolution.LinkedRecord[]
  },
  Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice
> =>
  Effect.map(LinkPlan.make(files, linkChoices), (plan) => ({
    resolvedFiles: Array.map(files, FileResolution.resolveFile(plan)),
    linked: FileResolution.linkedRecords(plan),
  }))

/** {@link resolveAcross} over `files`, run on the test clock. */
const resolveAcrossOnTestClock = (
  files: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>,
  linkChoices: ReferentLinkChoices.Type
): Effect.Effect.Success<ReturnType<typeof resolveAcross>> =>
  runOnTestClock(resolveAcross(files, linkChoices))

/** The one resolved file of a batch of one `file`, run on the test clock. */
const resolveOnTestClock = (
  file: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoices.Type
): DecodedFile.DecodedFile =>
  Array.headNonEmpty(resolveAcrossOnTestClock(Array.of(file), linkChoices).resolvedFiles)

/** The linked records of a batch of one `file`, run on the test clock. */
const linkedOnTestClock = (
  file: DecodedFile.DecodedFile,
  linkChoices: ReferentLinkChoices.Type
): readonly FileResolution.LinkedRecord[] =>
  resolveAcrossOnTestClock(Array.of(file), linkChoices).linked

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
      resources: section.resources.map((entry) => [entry.key, entry.title, wireOf(entry.resource)]),
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

/** A Shoppers-style history `subject`: a logical reference to the account. */
const customerSubject = (customerId: string): object => ({
  type: 'Patient',
  identifier: { system: CUSTOMER, value: customerId },
})

/** A Shoppers-style `requester`: a logical reference to a prescriber known only by name. */
const namedRequester = (name: string): object => ({
  type: 'Practitioner',
  identifier: { system: Practitioner.NAME_IDENTIFIER_SYSTEM, value: name },
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
      resources: resources.map((resource, index) => ({
        key: `k-${index}`,
        title: `${resource.resourceType}/${resource.id}`,
        resource,
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
  ...POOL.map((value) => `Patient|${SOURCE_PATIENT}|${value}`),
  ...POOL.map((value) => `Patient|${CUSTOMER}|c-${value}`),
  ...POOL.map((value) => `Practitioner|${SOURCE_PRACTITIONER}|pr-${value}`),
  ...NAMES.map((name) => `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|${name}`),
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
      const entries = file.sections.flatMap((section) => section.resources)
      return {
        ...file,
        sections: [
          { title: 'First', resources: entries.slice(0, split) },
          { title: 'Second', resources: entries.slice(split) },
        ],
      }
    })
  )

const anyChoiceArbitrary: fc.Arbitrary<LinkChoice.Type> = fc.oneof(
  fc.constant(LinkChoice.CreateResource()),
  fc.constant(LinkChoice.DontLink()),
  fc.constantFrom(...STORED).map((resource) => LinkChoice.LinkToStoredResource({ resource })),
  fc.constantFrom(...STORED).map((resource) => LinkChoice.UpdateStoredResource({ resource })),
  fc
    .constantFrom(...POOL_KEYS)
    .map((referentKey) => LinkChoice.LinkToDecodedReferent({ referentKey }))
)

/** Generated choices over the pool's keys, any choice on any referent, impossible ones included. */
const anyChoicesArbitrary: fc.Arbitrary<ReferentLinkChoices.Type> = fc
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

/** A choice `referent` can take, linking only to referents of `referents`. */
const choiceForArbitrary = (
  referent: Referent.Type,
  referents: readonly Referent.Type[]
): fc.Arbitrary<LinkChoice.Type> => {
  const { type } = referent.logicalReference
  const linkToStoredResource = fc
    .constantFrom(...STORED.filter((stored) => stored.resourceType === type))
    .map((resource) => LinkChoice.LinkToStoredResource({ resource }))
  return Referent.match(referent, {
    AsResource: ({ resource }) =>
      fc.oneof(
        fc.constant(LinkChoice.CreateResource()),
        fc.constant(LinkChoice.UpdateStoredResource({ resource: storedCopyOf(resource) })),
        linkToStoredResource
      ),
    ByMentionOnly: ({ logicalReference }) =>
      fc.oneof(
        fc.constant(LinkChoice.DontLink()),
        linkToStoredResource,
        fc
          .constantFrom(
            ...referents.filter((linked) => linked.logicalReference.type === type).map(Referent.key)
          )
          .map((referentKey) => LinkChoice.LinkToDecodedReferent({ referentKey })),
        ...(Option.isSome(LinkableResource.tryProvisionalFrom(logicalReference))
          ? [fc.constant(LinkChoice.CreateResource())]
          : [])
      ),
  })
}

/** Generated choices every referent of `file` can take, or none for some. */
const choicesForArbitrary = (
  file: DecodedFile.DecodedFile
): fc.Arbitrary<ReferentLinkChoices.Type> => {
  const referents = discoverOnTestClock(file)
  return fc
    .tuple(
      ...referents.map((referent) =>
        fc
          .option(choiceForArbitrary(referent, referents), { nil: undefined })
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
  readonly choices: ReferentLinkChoices.Type
}> = fileArbitrary.chain((file) => choicesForArbitrary(file).map((choices) => ({ file, choices })))

/**
 * Whether a mention of `file` is one several of its decoded resources answer
 * to and none is keyed by. On the decoded file it is a referent of its own;
 * once those resources resolve to one stored resource, that resource alone
 * answers to it, so the resolved file has a referent fewer.
 */
const hasMentionSeveralResourcesAnswerTo = (file: DecodedFile.DecodedFile): boolean => {
  const referents = discoverOnTestClock(file)
  const answeredKeys = referents
    .filter(Referent.is('AsResource'))
    .flatMap((referent) => Referent.logicalReferencesOf(referent).map(LinkableLogicalReference.key))
  return referents
    .filter(Referent.is('ByMentionOnly'))
    .some(
      (referent) =>
        answeredKeys.filter((answeredKey) => answeredKey === Referent.key(referent)).length > 1
    )
}

/**
 * Whether following the `LinkToDecodedReferent` choices of `choices` from
 * some referent comes back to it. A cycle links its members to a provisional
 * resource, which the resolved file then holds as a resource keyed by one of
 * them, whose `LinkToDecodedReferent` no longer fits it.
 */
const hasLinkCycle = (choices: ReferentLinkChoices.Type): boolean =>
  [...HashMap.keys(choices)].some((startKey) => {
    const walked = new Set<string>()
    let referentKey = startKey
    for (;;) {
      const choice = HashMap.get(choices, referentKey)
      if (Option.isNone(choice) || !LinkChoice.is('LinkToDecodedReferent')(choice.value)) {
        return false
      }
      if (walked.has(referentKey)) return true
      walked.add(referentKey)
      referentKey = choice.value.referentKey
    }
  })

/**
 * Whether a mention of `file` names something a stored resource `choices`
 * link to answers to, by an identifier it carries or derives (a provider's
 * printed name). On the decoded file the mention is a referent of its own;
 * once the stored resource stands in the resolved file, it answers to it.
 */
const hasMentionALinkedStoredResourceAnswersTo = (
  file: DecodedFile.DecodedFile,
  choices: ReferentLinkChoices.Type
): boolean => {
  const storedAnswerKeys = [...HashMap.values(choices)]
    .filter(LinkChoice.is('LinkToStoredResource'))
    .flatMap(({ resource }) =>
      [
        ...resource.identifier,
        ...Option.toArray(runOnTestClock(LinkableResource.maybeDerivedIdentifier(resource))),
      ].flatMap((identifier) =>
        Option.toArray(
          LinkableLogicalReference.tryFromIdentifier(resource.resourceType, identifier)
        )
      )
    )
    .map(LinkableLogicalReference.key)
  return discoverOnTestClock(file)
    .filter(Referent.is('ByMentionOnly'))
    .some((referent) => storedAnswerKeys.includes(Referent.key(referent)))
}

/**
 * A generated decoded file and choices whose resolved file has the decoded
 * file's referents, of the same kinds, so the choices apply to it as they did
 * to the decoded one. That rules out a link cycle ({@link hasLinkCycle}), a
 * mention several decoded resources answer to
 * ({@link hasMentionSeveralResourcesAnswerTo}), and a mention a linked stored
 * resource answers to ({@link hasMentionALinkedStoredResourceAnswersTo}).
 */
const fileWithReapplicableChoicesArbitrary = fileWithChoicesArbitrary.filter(
  ({ file, choices }) =>
    !hasLinkCycle(choices) &&
    !hasMentionSeveralResourcesAnswerTo(file) &&
    !hasMentionALinkedStoredResourceAnswersTo(file, choices)
)

export {
  ABSOLUTE,
  CUSTOMER,
  DEVICE,
  SOURCE_PATIENT,
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
  fileWithReapplicableChoicesArbitrary,
  linkedOnTestClock,
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
