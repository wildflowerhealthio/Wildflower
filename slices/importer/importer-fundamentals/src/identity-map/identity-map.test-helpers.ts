/**
 * What the identity-map tests share: wire builders for the shapes the Shoppers
 * and LifeLabs decodes emit, generated decoded files over a small pool of
 * identities, and the wire-side oracles the properties compare by.
 *
 * @packageDocumentation
 */

import {
  FhirResourceSchema,
  Observation,
  Patient,
  Practitioner,
  type FhirResource,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Arbitrary, FastCheck as fc, Schema } from 'effect'

import type * as DecodedFile from '../decoded-file.ts'
import type * as IdentityMap from './identity-map.ts'
import * as LinkChoice from './link-choice.ts'
import type * as LinkableResource from './linkable-resource.ts'

const SOURCE_PATIENT = 'https://source.example/patient-id'
const SOURCE_PRACTITIONER = 'https://source.example/practitioner-id'
const CUSTOMER = 'https://source.example/customer-id'
const DEVICE = 'https://device.example/id'
const ABSOLUTE = 'https://elsewhere.example/fhir/Patient/1'

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)
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
}: PatientArgs): Patient.Type =>
  Schema.decodeUnknownSync(Patient.Schema)({
    resourceType: 'Patient',
    id,
    identifier: [{ system, value }],
    name: family === null ? [] : [{ family, given: given === null ? [] : [given] }],
    ...(birthDate === null ? {} : { birthDate }),
  })

/** A decoded `Practitioner` named only by printed `text`, as LifeLabs writes one. */
const practitioner = (id: string, text: string, system = SOURCE_PRACTITIONER): Practitioner.Type =>
  Schema.decodeUnknownSync(Practitioner.Schema)({
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

/** A Shoppers-style history `subject`: the account by identifier alone. */
const customerSubject = (customerId: string): object => ({
  identifier: { system: CUSTOMER, value: customerId },
})

/** A Shoppers-style `requester`: a prescriber known only by name. */
const namedRequester = (name: string): object => ({
  identifier: { system: Practitioner.NAME_IDENTIFIER_SYSTEM, value: name },
  display: name,
})

/** A decoded `MedicationRequest` with the given `subject` and optional `requester`. */
const request = (id: string, subject: object, requester?: object): FhirResource =>
  decodeResource({
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
): FhirResource =>
  decodeResource({
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { text: 'Glucose' },
    ...(subject === undefined ? {} : { subject }),
    performer,
  })

/** A decoded file of one section, keyed `k-<index>`. */
const fileOf = (...resources: readonly FhirResource[]): DecodedFile.DecodedFile => ({
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
const storedOf = (resource: FhirResource): LinkableResource.WithId => {
  if (
    (resource.resourceType !== 'Patient' && resource.resourceType !== 'Practitioner') ||
    resource.id === null
  ) {
    throw new Error('a stored resource is a Patient or Practitioner with an id')
  }
  return { ...resource, id: resource.id }
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
  valueArbitrary.map((value) => ({ identifier: { system: SOURCE_PATIENT, value } })),
  fc.constant({ reference: ABSOLUTE }),
  fc.constant(undefined)
)

const performerArbitrary: fc.Arbitrary<object> = fc.oneof(
  fc.constantFrom(...NAMES).map(namedRequester),
  valueArbitrary.map((value) => ({ reference: `Practitioner/pr-${value}` })),
  fc.constant({ display: 'LifeLabs · 100 International Blvd' })
)

/** Generated resources with no reference into the pool, so no map entry can touch them. */
const unrelatedArbitrary: fc.Arbitrary<FhirResource> = Arbitrary.make(Observation.Schema).map(
  (generated): FhirResource => ({ ...generated, contained: [] })
)

/** A generated resource, over the pool of identities. */
const resourceArbitrary: fc.Arbitrary<FhirResource> = fc.oneof(
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

const choiceArbitrary: fc.Arbitrary<LinkChoice.Type> = fc.oneof(
  fc.constant(LinkChoice.Create()),
  fc.constant(LinkChoice.DontLink()),
  fc.constantFrom(...STORED).map((resource) => LinkChoice.LinkToStored({ resource })),
  fc.constantFrom(...POOL_KEYS).map((referentKey) => LinkChoice.LinkToReferent({ referentKey }))
)

/** Generated choices over the pool's keys, any choice on any referent, impossible ones included. */
const choicesArbitrary: fc.Arbitrary<IdentityMap.Type> = fc
  .array(fc.tuple(fc.constantFrom(...POOL_KEYS), choiceArbitrary), { maxLength: POOL_KEYS.length })
  .map((entries) => new Map(entries))

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
  customerSubject,
  fileArbitrary,
  fileOf,
  fileWireOf,
  literalSubject,
  choicesArbitrary,
  namedRequester,
  observation,
  patient,
  practitioner,
  request,
  storedOf,
  unrelatedArbitrary,
  wireFieldsOf,
  wireOf,
}
