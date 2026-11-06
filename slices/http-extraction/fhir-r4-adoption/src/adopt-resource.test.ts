import {
  IdentifierAndReference,
  type IdentifierType,
  type ReferenceType,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  Binary,
  CarePlan,
  type CarePlanActivityDetail,
  DiagnosticReport,
  DocumentReference,
  LogicalReference,
  type FhirResource,
  type FhirResourceWithId,
  Goal,
  ImagingStudy,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  PlanDefinition,
  PlanDefinitionAction,
  Practitioner,
  Procedure,
  ServiceRequest,
} from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Array as Arr, Effect, FastCheck as fc, Option, Schema, SchemaAST } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { adopt, adoptedReferenceOf, originalIdOf } from './adopt-resource.ts'
import * as DetachedResource from './detached-resource.ts'
import * as ReferencePlan from './reference-plan.ts'

/**
 * Covers detaching a single resource from its source (no id, keyed by its
 * first identifier, its references logical) and adopting a detached one (the
 * id it is given, and its references by key resolved).
 * Three failure modes this suite exists to catch, each of which loses data
 * silently:
 *
 * - identifiers the source already carried being clobbered (asserted by value,
 *   never by reference);
 * - fields that hold no reference being blanked or invented (asserted by
 *   diffing everything {@link TOUCHED_FIELDS} does *not* name);
 * - detach accepting reference strings that are not relative references
 *   (a `#fragment`, a `urn:uuid:`, an id with a space).
 *
 * Resources come from each schema's own arbitrary rather than hand-rolled
 * shapes, so every field is populated with something — a hand-built shell would
 * leave the "did detach or adopt blank it?" question unasked for whatever the
 * author forgot to fill in.
 */

/** The FHIR server the records are detached from: its base URL. */
const BASE = 'https://source.example/baseR4'

/** {@link BASE}'s system for `resourceType`, `<baseUrl>/<Type>`. */
const fhirSystem = (resourceType: string): string => `${BASE}/${resourceType}`

/** A system no record here is keyed in. */
const SYSTEM = 'https://wildflowerhealth.io/fhir/sid/example-portal'

/** {@link BASE}'s `fromServerRecord`. */
const detachFhir = DetachedResource.fromServerRecord(BASE)

/** The id a keyless record adopted here is stored under. */
const KEYLESS_ID = 'keyless-1'

/**
 * An adoption over `batch`, as the import stage runs one over a file set with
 * its resource plans: a keyed record is stored under the id its key derives
 * and a keyless one under {@link KEYLESS_ID}, and a logical reference
 * resolves when `batch` holds the record of its type keyed by its identifier.
 */
const adoptionOver = (
  batch: readonly DetachedResource.Type[]
): ((record: DetachedResource.Type) => FhirResourceWithId) => {
  const idOf = (record: DetachedResource.Type): string =>
    Option.match(DetachedResource.keyOf(record), {
      onSome: ({ system, value }) => localResourceId(system, record.resourceType, value),
      onNone: () => KEYLESS_ID,
    })
  const adoptRecord = adopt(
    ReferencePlan.of(
      Arr.filterMap(batch, (record) =>
        Option.map(DetachedResource.keyIdentifierOf(record), (identifier) => ({
          logicalReference: LogicalReference.make(record.resourceType, identifier),
          literalReference: `${record.resourceType}/${idOf(record)}`,
        }))
      )
    )
  )
  return (record) => adoptRecord(record, idOf(record))
}

/**
 * `resource` detached from {@link BASE} and adopted in a batch of it and
 * `others`, all detached from {@link BASE}.
 */
const detachThenAdopt = (
  resource: FhirResource,
  ...others: readonly FhirResource[]
): FhirResourceWithId => {
  const detached = detachFhir(resource)
  return adoptionOver([detached, ...others.map(detachFhir)])(detached)
}

const reference = (overrides: Partial<ReferenceType> = {}): ReferenceType => ({
  id: null,
  extension: [],
  display: null,
  identifier: null,
  reference: null,
  type: null,
  ...overrides,
})

const identifier = (overrides: Partial<IdentifierType> = {}): IdentifierType => ({
  id: null,
  extension: [],
  assigner: null,
  period: null,
  system: null,
  type: null,
  use: null,
  value: null,
  ...overrides,
})

/** One deterministic, schema-valid resource of the given type. */
const sample = <A, I>(schema: Schema.Schema<A, I>, seed: number): A => {
  const [value] = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed })
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return value
}

/**
 * Every field detach or adopt is permitted to touch, per resource type. This
 * table is the contract; the "no collateral change" properties below diff
 * everything *not* named here.
 */
const TOUCHED_FIELDS = {
  Binary: ['id', 'securityContext'],
  Patient: ['id', 'identifier', 'generalPractitioner', 'managingOrganization', 'link', 'contact'],
  Observation: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'device',
    'specimen',
    'basedOn',
    'derivedFrom',
    'focus',
    'hasMember',
    'note',
    'partOf',
    'performer',
  ],
  MedicationRequest: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'requester',
    'performer',
    'recorder',
    'priorPrescription',
    'reportedReference',
    'medicationReference',
    'supportingInformation',
    'reasonReference',
    'basedOn',
    'insurance',
    'detectedIssue',
    'eventHistory',
    'note',
    'dispenseRequest',
  ],
  MedicationDispense: [
    'id',
    'identifier',
    'subject',
    'context',
    'location',
    'destination',
    'statusReasonReference',
    'medicationReference',
    'partOf',
    'supportingInformation',
    'authorizingPrescription',
    'receiver',
    'detectedIssue',
    'eventHistory',
    'note',
    'performer',
    'substitution',
  ],
  DocumentReference: [
    'id',
    'identifier',
    'subject',
    'authenticator',
    'custodian',
    'author',
    'relatesTo',
    'context',
  ],
  DiagnosticReport: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'basedOn',
    'performer',
    'resultsInterpreter',
    'specimen',
    'result',
    'imagingStudy',
    'media',
  ],
  Practitioner: ['id', 'identifier', 'qualification'],
  ServiceRequest: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'requester',
    'basedOn',
    'replaces',
    'performer',
    'locationReference',
    'reasonReference',
    'insurance',
    'supportingInfo',
    'relevantHistory',
  ],
  ImagingStudy: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'referrer',
    'procedureReference',
    'location',
    'basedOn',
    'interpreter',
    'endpoint',
    'reasonReference',
    'series',
  ],
  CarePlan: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'author',
    'basedOn',
    'replaces',
    'partOf',
    'contributor',
    'careTeam',
    'addresses',
    'supportingInfo',
    'goal',
    'activity',
    'note',
  ],
  Goal: ['id', 'identifier', 'subject', 'expressedBy', 'addresses', 'note', 'outcomeReference'],
  PlanDefinition: ['id', 'identifier', 'subjectReference', 'action'],
  Procedure: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'recorder',
    'asserter',
    'location',
    'basedOn',
    'partOf',
    'performer',
    'reasonReference',
    'report',
    'complicationDetail',
    'focalDevice',
    'usedReference',
    'note',
  ],
} as const satisfies Record<FhirResource['resourceType'], readonly string[]>

// ---------------------------------------------------------------------------
// Schema-derived reference coverage.
//
// The complement diff below cannot catch a `Reference` missing from *both* the
// implementation and `TOUCHED_FIELDS`: detach and adopt leave it alone, and
// that property asserts precisely that it was left alone. The guard below closes that
// hole by deriving the truth from the schemas. It found `note.authorReference`,
// which a manual walk of the same six original schemas had missed.
// ---------------------------------------------------------------------------

/** A runaway backstop, not a bound anything real approaches. */
const MAX_WALK_DEPTH = 40

/**
 * Fields whose subtrees are exempt by policy, at any depth — the exemption list
 * in the Source Identity Explanation. `Extension` is also recursive, so
 * descending would not terminate anyway.
 */
const EXEMPT_SUBTREES = new Set(['extension', 'modifierExtension', 'contained'])

/** The sorted field names of a struct-shaped node, or `''` for anything else. */
const shapeOf = (node: SchemaAST.AST): string =>
  SchemaAST.isTypeLiteral(node)
    ? node.propertySignatures
        .map((property) => String(property.name))
        .toSorted()
        .join(',')
    : ''

/** `shapeOf`, but seeing through the wrappers a datatype schema is built from. */
const declaredShapeOf = (node: SchemaAST.AST, depth = 0): string => {
  if (depth > MAX_WALK_DEPTH) return ''
  if (SchemaAST.isTypeLiteral(node)) return shapeOf(node)
  if (SchemaAST.isSuspend(node)) return declaredShapeOf(node.f(), depth + 1)
  if (SchemaAST.isTransformation(node)) return declaredShapeOf(node.to, depth + 1)
  if (SchemaAST.isRefinement(node)) return declaredShapeOf(node.from, depth + 1)
  return ''
}

// Matched structurally rather than by AST identity: Effect rebuilds nodes when
// it forces a `Suspend`, so `node === IdentifierAndReference.ReferenceSchema.ast` is false for the very
// occurrences this needs to find.
const REFERENCE_SHAPE = declaredShapeOf(IdentifierAndReference.ReferenceSchema.ast)
const IDENTIFIER_SHAPE = declaredShapeOf(IdentifierAndReference.IdentifierSchema.ast)

/**
 * Every dotted path at which a resource schema declares a `Reference`.
 *
 * @remarks
 * Stops at a `Reference` (that is the find) and at an `Identifier`, whose
 * `assigner` is rewritten under the `identifier` field {@link TOUCHED_FIELDS}
 * already names. Those two stops also break the `Reference` ⇄ `Identifier`
 * cycle. A struct
 * nested in one of its own shape stops too: a recursive element
 * (`PlanDefinition.action`) reports its references once, at its outermost
 * path, and the walk rewrites them at every depth.
 *
 * Throws rather than truncating at {@link MAX_WALK_DEPTH}: a silently-cut walk
 * reports *fewer* references than exist, which is the failure this guard exists
 * to prevent.
 */
const referencePathsIn = (schema: { readonly ast: SchemaAST.AST }): readonly string[] => {
  const found: string[] = []
  const walk = (
    node: SchemaAST.AST,
    path: readonly string[],
    depth: number,
    enclosing: readonly string[] = []
  ): void => {
    if (depth > MAX_WALK_DEPTH) {
      throw new Error(`reference walk exceeded ${MAX_WALK_DEPTH} at ${path.join('.')}`)
    }
    const shape = shapeOf(node)
    if (shape !== '' && shape === REFERENCE_SHAPE) {
      found.push(path.join('.'))
      return
    }
    if (shape !== '' && shape === IDENTIFIER_SHAPE) return
    // A struct nested in one of its own shape (`PlanDefinition.action.action`)
    // declares the references its enclosing copy already reported.
    if (shape !== '' && enclosing.includes(shape)) return
    const within = shape === '' ? enclosing : [...enclosing, shape]
    if (SchemaAST.isSuspend(node)) return walk(node.f(), path, depth + 1, within)
    if (SchemaAST.isTypeLiteral(node)) {
      for (const property of node.propertySignatures) {
        const name = String(property.name)
        if (!EXEMPT_SUBTREES.has(name)) walk(property.type, [...path, name], depth + 1, within)
      }
      return
    }
    if (SchemaAST.isUnion(node)) {
      for (const member of node.types) walk(member, path, depth + 1, within)
      return
    }
    if (SchemaAST.isTupleType(node)) {
      for (const element of node.elements) walk(element.type, path, depth + 1, within)
      for (const rest of node.rest) walk(rest.type, path, depth + 1, within)
      return
    }
    if (SchemaAST.isTransformation(node)) return walk(node.to, path, depth + 1, within)
    if (SchemaAST.isRefinement(node)) return walk(node.from, path, depth + 1, within)
    // `OrNullAsOptional` is a `Declaration` wrapping the real schema, so the
    // inner type hides in its type parameters rather than under a `from`/`to`.
    if (SchemaAST.isDeclaration(node)) {
      for (const parameter of node.typeParameters) walk(parameter, path, depth + 1, within)
      return
    }
  }
  walk(schema.ast, [], 0)
  return [...new Set(found)].toSorted()
}

/**
 * Every `Reference` the implementation rewrites, as a dotted path.
 *
 * @remarks
 * Dotted rather than top-level so a *nested* reference added beside one already
 * covered — a second slot on `dispenseRequest`, say — fails too, instead of
 * hiding behind a top-level field already in `TOUCHED_FIELDS`.
 */
const REWRITTEN_REFERENCE_PATHS = {
  Binary: ['securityContext'],
  Patient: ['contact.organization', 'generalPractitioner', 'link.other', 'managingOrganization'],
  Observation: [
    'basedOn',
    'derivedFrom',
    'device',
    'encounter',
    'focus',
    'hasMember',
    'note.authorReference',
    'partOf',
    'performer',
    'specimen',
    'subject',
  ],
  MedicationRequest: [
    'basedOn',
    'detectedIssue',
    'dispenseRequest.performer',
    'encounter',
    'eventHistory',
    'insurance',
    'medicationReference',
    'note.authorReference',
    'performer',
    'priorPrescription',
    'reasonReference',
    'recorder',
    'reportedReference',
    'requester',
    'subject',
    'supportingInformation',
  ],
  MedicationDispense: [
    'authorizingPrescription',
    'context',
    'destination',
    'detectedIssue',
    'eventHistory',
    'location',
    'medicationReference',
    'note.authorReference',
    'partOf',
    'performer.actor',
    'receiver',
    'statusReasonReference',
    'subject',
    'substitution.responsibleParty',
    'supportingInformation',
  ],
  DocumentReference: [
    'authenticator',
    'author',
    'context.encounter',
    'context.related',
    'context.sourcePatientInfo',
    'custodian',
    'relatesTo.target',
    'subject',
  ],
  DiagnosticReport: [
    'basedOn',
    'encounter',
    'imagingStudy',
    'media.link',
    'performer',
    'result',
    'resultsInterpreter',
    'specimen',
    'subject',
  ],
  Practitioner: ['qualification.issuer'],
  ServiceRequest: [
    'basedOn',
    'encounter',
    'insurance',
    'locationReference',
    'performer',
    'reasonReference',
    'relevantHistory',
    'replaces',
    'requester',
    'subject',
    'supportingInfo',
  ],
  ImagingStudy: [
    'basedOn',
    'encounter',
    'endpoint',
    'interpreter',
    'location',
    'procedureReference',
    'reasonReference',
    'referrer',
    'series.endpoint',
    'series.performer.actor',
    'series.specimen',
    'subject',
  ],
  CarePlan: [
    'activity.detail.goal',
    'activity.detail.location',
    'activity.detail.performer',
    'activity.detail.productReference',
    'activity.detail.reasonReference',
    'activity.outcomeReference',
    'activity.progress.authorReference',
    'activity.reference',
    'addresses',
    'author',
    'basedOn',
    'careTeam',
    'contributor',
    'encounter',
    'goal',
    'note.authorReference',
    'partOf',
    'replaces',
    'subject',
    'supportingInfo',
  ],
  Goal: ['addresses', 'expressedBy', 'note.authorReference', 'outcomeReference', 'subject'],
  PlanDefinition: ['action.subjectReference', 'subjectReference'],
  Procedure: [
    'asserter',
    'basedOn',
    'complicationDetail',
    'encounter',
    'focalDevice.manipulated',
    'location',
    'note.authorReference',
    'partOf',
    'performer.actor',
    'performer.onBehalfOf',
    'reasonReference',
    'recorder',
    'report',
    'subject',
    'usedReference',
  ],
} as const satisfies Record<FhirResource['resourceType'], readonly string[]>

const SCHEMA_FOR = {
  Binary: Binary.Schema,
  Patient: Patient.Schema,
  Observation: Observation.Schema,
  MedicationRequest: MedicationRequest.Schema,
  MedicationDispense: MedicationDispense.Schema,
  DocumentReference: DocumentReference.Schema,
  DiagnosticReport: DiagnosticReport.Schema,
  Practitioner: Practitioner.Schema,
  ServiceRequest: ServiceRequest.Schema,
  ImagingStudy: ImagingStudy.Schema,
  CarePlan: CarePlan.Schema,
  Goal: Goal.Schema,
  PlanDefinition: PlanDefinition.Schema,
  Procedure: Procedure.Schema,
} as const satisfies Record<FhirResource['resourceType'], Schema.Schema.Any>

describe('reference coverage is derived from the schemas, not asserted by hand', () => {
  // Swept off `resources` rather than `Object.keys(SCHEMA_FOR)`, which is typed
  // `string[]` and would need an assertion to narrow. `resources` is one entry
  // per member of the closed union and is already correctly typed; the test
  // below pins that it stays one-per-type.
  test('the sweep covers every resource type in the closed union', () => {
    expect(resources.map((resource) => resource.resourceType).toSorted()).toEqual(
      Object.keys(SCHEMA_FOR).toSorted()
    )
  })

  for (const { resourceType } of resources) {
    // A `Reference` field added to a resource schema and not to the list lands
    // on the left of this comparison and nowhere on the right, and fails here
    // — instead of the "no collateral change" properties below flagging the
    // field the walk rightly rewrites.
    test(`${resourceType}: every Reference the schema declares is listed`, () => {
      expect(referencePathsIn(SCHEMA_FOR[resourceType])).toEqual(
        [...REWRITTEN_REFERENCE_PATHS[resourceType]].toSorted()
      )
    })

    // Ties the dotted list to the flat table, so the "no collateral change"
    // properties below cannot go stale against it.
    test(`${resourceType}: every rewritten path is rooted in an adopted field`, () => {
      const roots = new Set(
        REWRITTEN_REFERENCE_PATHS[resourceType].map((path) => path.split('.')[0])
      )
      expect([...roots].toSorted()).toEqual(
        TOUCHED_FIELDS[resourceType]
          .filter((field) => field !== 'id' && field !== 'identifier')
          .toSorted()
      )
    })
  }

  test('the walk actually finds things — a guard that found nothing would pass everything', () => {
    expect(REFERENCE_SHAPE).not.toBe('')
    expect(IDENTIFIER_SHAPE).not.toBe(REFERENCE_SHAPE)
    expect(referencePathsIn(Observation.Schema).length).toBeGreaterThan(5)
  })
})

/** Every own field of `resource` except the ones detach or adopt may rewrite. */
const untouchedFields = (resource: FhirResource): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(resource).filter(
      ([key]) => !TOUCHED_FIELDS[resource.resourceType].some((field) => field === key)
    )
  )

/** One generated resource per type in the closed union, with a known id. */
const resources: readonly FhirResource[] = [
  { ...sample(Binary.Schema, 11), id: 'src-1' },
  { ...sample(Patient.Schema, 12), id: 'src-1' },
  { ...sample(Observation.Schema, 13), id: 'src-1' },
  { ...sample(MedicationRequest.Schema, 14), id: 'src-1' },
  { ...sample(MedicationDispense.Schema, 15), id: 'src-1' },
  { ...sample(DocumentReference.Schema, 16), id: 'src-1' },
  { ...sample(DiagnosticReport.Schema, 17), id: 'src-1' },
  { ...sample(Practitioner.Schema, 18), id: 'src-1' },
  { ...sample(ServiceRequest.Schema, 19), id: 'src-1' },
  { ...sample(ImagingStudy.Schema, 20), id: 'src-1' },
  { ...sample(CarePlan.Schema, 21), id: 'src-1' },
  { ...sample(Goal.Schema, 22), id: 'src-1' },
  { ...sample(PlanDefinition.Schema, 23), id: 'src-1' },
  { ...sample(Procedure.Schema, 24), id: 'src-1' },
]

/** A Patient detached, narrowed back to a Patient. */
const asPatient = (resource: FhirResource): typeof Patient.Schema.Type => {
  if (resource.resourceType !== 'Patient') throw new Error('unreachable: expected a Patient')
  return resource
}

/** An Observation, narrowed back to one. */
const asObservation = (resource: FhirResource): typeof Observation.Schema.Type => {
  if (resource.resourceType !== 'Observation') {
    throw new Error('unreachable: expected an Observation')
  }
  return resource
}

describe('DetachedResource.fromServerRecord', () => {
  for (const resource of resources) {
    const { resourceType } = resource

    test(`${resourceType}: drops the id`, () => {
      expect(detachFhir(resource).id).toBeNull()
    })

    // The whole point of diffing the complement of the reference fields: a rewrite that
    // spread a stale copy, or blanked a field it did not mean to name, shows up
    // here rather than passing unnoticed because no assertion mentioned it.
    test(`${resourceType}: changes nothing outside its reference fields`, () => {
      const detached = detachFhir(resource)
      expect(Object.keys(detached).toSorted()).toEqual(Object.keys(resource).toSorted())
      expect(untouchedFields(detached)).toEqual(untouchedFields(resource))
    })

    test(`${resourceType}: leaves contained byte-untouched`, () => {
      // `contained` is raw passthrough JSON — a decoded Identifier injected in
      // there would write `null`s onto the wire.
      const detached = detachFhir(resource)
      if ('contained' in detached && 'contained' in resource) {
        expect(detached.contained).toBe(resource.contained)
      }
    })
  }

  test('keys every type with an identifier element by its id, in the system its server gives the type', () => {
    for (const resource of resources) {
      if (resource.resourceType === 'Binary') continue
      expect(DetachedResource.keyOf(detachFhir(resource))).toEqual(
        Option.some({ system: fhirSystem(resource.resourceType), value: 'src-1' })
      )
    }
  })

  test('keeps every identifier the source already carried, behind the key', () => {
    const existing = [
      identifier({ value: 'mrn-9', system: new URL('https://source.example/sid/mrn') }),
      identifier({ value: 'ohip-4' }),
    ]
    const detached = asPatient(
      detachFhir({ ...sample(Patient.Schema, 12), id: 'src-1', identifier: existing })
    )

    expect(detached.identifier[0]).toEqual(
      identifier({ value: 'src-1', system: new URL(fhirSystem('Patient')) })
    )
    // Compared by value. Detach necessarily builds a new array, so there is no
    // reference to assert on — and an implementation that rebuilt it from a
    // stale copy of the resource would be caught only by the contents.
    expect(detached.identifier.slice(1)).toEqual(existing)
  })

  test('a Binary is keyless — R4 gives it no identifier element', () => {
    const detached = detachFhir<typeof Binary.Schema.Type>({
      ...sample(Binary.Schema, 11),
      id: 'src-1',
    })
    expect(detached.id).toBeNull()
    expect('identifier' in detached).toBe(false)
    expect(DetachedResource.keyOf(detached)).toEqual(Option.none())
  })

  test('a record the source gave no id keeps only its own identifiers, the first its key', () => {
    const own = identifier({ value: 'mrn-9', system: new URL('https://source.example/sid/mrn') })
    const detached = detachFhir({ ...sample(Patient.Schema, 12), id: null, identifier: [own] })
    expect(asPatient(detached).identifier).toEqual([own])
    expect(DetachedResource.keyOf(detached)).toEqual(
      Option.some({ system: 'https://source.example/sid/mrn', value: 'mrn-9' })
    )
  })

  test('a record with no id and no qualified identifier is keyless', () => {
    const detached = detachFhir({
      ...sample(Patient.Schema, 12),
      id: null,
      identifier: [identifier({ value: 'no-system' })],
    })
    expect(DetachedResource.keyOf(detached)).toEqual(Option.none())
  })
})

describe('detaching references', () => {
  const observationWith = (subject: ReferenceType): typeof Observation.Schema.Type => ({
    ...sample(Observation.Schema, 13),
    id: 'obs-1',
    subject,
  })

  const subjectOf = (baseUrl: string, subject: ReferenceType): ReferenceType | null =>
    asObservation(DetachedResource.fromServerRecord(baseUrl)(observationWith(subject))).subject

  test('a literal reference becomes the logical reference to its target by its key', () => {
    expect(subjectOf(BASE, reference({ reference: 'Patient/pat-7', display: 'Avery' }))).toEqual(
      reference({
        type: 'Patient',
        identifier: identifier({ value: 'pat-7', system: new URL(fhirSystem('Patient')) }),
        display: 'Avery',
      })
    )
  })

  test("the logical reference names the target by exactly the key the target's own detach gives it", () => {
    const patient = detachFhir({ ...sample(Patient.Schema, 12), id: 'pat-7' })
    const subject = subjectOf(BASE, reference({ reference: 'Patient/pat-7' }))
    expect(
      Option.map(DetachedResource.keyOf(patient), (key) => ({
        system: new URL(key.system),
        value: key.value,
      }))
    ).toEqual(
      Option.some({ system: subject?.identifier?.system, value: subject?.identifier?.value })
    )
  })

  // `Reference.identifier` is 0..1, and the logical reference needs it for the
  // target's key: the source's own identifier there is replaced. The target
  // carries its own identifiers, so nothing it knew of itself is lost.
  test("replaces an identifier the source had also put on a literal reference with the target's key", () => {
    const vendor = identifier({
      value: 'pharmacy-4821',
      system: new URL('https://vendor.example/id'),
    })
    expect(
      subjectOf(BASE, reference({ reference: 'Patient/pat-7', identifier: vendor }))?.identifier
    ).toEqual(identifier({ value: 'pat-7', system: new URL(fhirSystem('Patient')) }))
  })

  test('detaches an absolute self-reference exactly as its relative spelling', () => {
    const relative = subjectOf(BASE, reference({ reference: 'Patient/pat-7' }))
    const absolute = subjectOf(
      BASE,
      reference({ reference: 'https://source.example/baseR4/Patient/pat-7' })
    )
    expect(absolute).toEqual(relative)
  })

  // Each of these is under the server's own base, but relativises to
  // something that is still not a `Type/id`, so it keeps its absolute
  // spelling rather than a half-relativised one.
  for (const [label, target] of [
    ['a versioned reference', `${BASE}/Patient/pat-7/_history/2`],
    ['a search URL', `${BASE}/Patient?identifier=mrn|9`],
    ['an id past 64 characters', `${BASE}/Patient/${'a'.repeat(65)}`],
  ] as const) {
    test(`keeps ${label} under the base in its absolute spelling`, () => {
      const original = reference({ reference: target })
      expect(subjectOf(BASE, original)).toEqual(original)
    })
  }

  test('keeps a reference under a longer base the base URL is only a prefix of', () => {
    const original = reference({ reference: 'https://h.example/fhir/R4/Patient/1' })
    expect(subjectOf('https://h.example/fhir', original)).toEqual(original)
  })

  for (const [label, target] of [
    ['a contained-resource fragment', '#med-1'],
    ['a urn:uuid reference', 'urn:uuid:5a3b2c1d-0000-4000-8000-000000000000'],
    ['a foreign absolute URL', 'https://elsewhere.example/fhir/Patient/pat-7'],
    ['a version-specific reference', 'Patient/pat-7/_history/2'],
    ['an id carrying a space', 'Patient/pat 7'],
    ['a hyphenated type token', 'rexall-pharmacy-location/pharmacy-4821'],
    ['an empty string', ''],
  ] as const) {
    test(`leaves ${label} untouched`, () => {
      const original = reference({ reference: target })
      expect(subjectOf(BASE, original)).toEqual(original)
    })
  }

  test('keeps an identifier-only reference exactly as the source wrote it', () => {
    const original = reference({
      type: 'Patient',
      identifier: identifier({
        value: 'account-1',
        system: new URL('https://portal.example/acct'),
      }),
    })
    expect(subjectOf(BASE, original)).toEqual(original)
  })

  test('detaches a reference to a type this package does not store, in that type’s system', () => {
    expect(subjectOf(BASE, reference({ reference: 'Organization/org-3' }))?.identifier).toEqual(
      identifier({ value: 'org-3', system: new URL(fhirSystem('Organization')) })
    )
  })

  test('detaches a reference to an R4 type this package does not model, in that type’s system', () => {
    expect(subjectOf(BASE, reference({ reference: 'Encounter/enc-1' }))).toEqual(
      reference({
        type: 'Encounter',
        identifier: identifier({ value: 'enc-1', system: new URL(fhirSystem('Encounter')) }),
      })
    )
  })

  // Carebook's `PrescriptionOrder/<id>` names no R4 resource, so nothing says
  // which namespace its id is in; the source's own identifier on it is the
  // only thing that says what it links to, and is kept.
  test('keeps a literal reference to a type R4 does not define as the source wrote it, identifier included', () => {
    const original = reference({
      reference: 'PrescriptionOrder/po-1',
      identifier: identifier({
        value: 'rx-1',
        system: new URL('https://vendor.example/identifier/order'),
      }),
    })
    expect(subjectOf(BASE, original)).toEqual(original)
  })

  // Found by the schema-derived coverage guard above, not by reading the spec:
  // `Annotation.author[x]` is a Reference when it is not the string variant, and
  // it sits one level down inside an array, which is why a manual walk missed it.
  test('detaches the author of a note, one level down inside an array', () => {
    const detached = asObservation(
      detachFhir({
        ...sample(Observation.Schema, 13),
        id: 'obs-1',
        note: [
          {
            id: null,
            extension: [],
            authorReference: reference({ reference: 'Practitioner/prac-3' }),
            authorString: null,
            text: 'Reviewed with the patient.',
            time: null,
          },
        ],
      })
    )

    expect(detached.note[0]?.authorReference).toEqual(
      reference({
        type: 'Practitioner',
        identifier: identifier({ value: 'prac-3', system: new URL(fhirSystem('Practitioner')) }),
      })
    )
    // The rest of the note is carried, not rebuilt.
    expect(detached.note[0]?.text).toBe('Reviewed with the patient.')
  })

  test('leaves a note alone when its author is the string variant', () => {
    const note = {
      id: null,
      extension: [],
      authorReference: null,
      authorString: 'Dr. Chen',
      text: 'Reviewed with the patient.',
      time: null,
    }
    const detached = asObservation(
      detachFhir({ ...sample(Observation.Schema, 13), id: 'obs-1', note: [note] })
    )

    expect(detached.note[0]).toEqual(note)
  })

  // `Identifier.assigner` is a Reference like any other: the walk reaches
  // every reference a resource carries, at any depth.
  test('detaches the assigner of an Identifier like any other reference', () => {
    const resource = {
      ...sample(Patient.Schema, 12),
      id: 'src-1',
      identifier: [
        identifier({ value: 'mrn-9', assigner: reference({ reference: 'Organization/org-2' }) }),
      ],
    }
    const detachedAssigner = reference({
      type: 'Organization',
      identifier: identifier({ value: 'org-2', system: new URL(fhirSystem('Organization')) }),
    })
    expect(asPatient(detachFhir(resource)).identifier[1]?.assigner).toEqual(detachedAssigner)
    expect(asPatient(detachThenAdopt(resource)).identifier[1]?.assigner).toEqual(detachedAssigner)
  })
})

describe('adopt', () => {
  for (const resource of resources) {
    const { resourceType } = resource
    test(`${resourceType}: changes nothing outside its reference fields`, () => {
      const detached = detachFhir(resource)
      const adopted = adoptionOver([detached])(detached)
      expect(Object.keys(adopted).toSorted()).toEqual(Object.keys(detached).toSorted())
      expect(untouchedFields(adopted)).toEqual(untouchedFields(detached))
      if (DetachedResource.hasIdentifier(adopted) && DetachedResource.hasIdentifier(detached)) {
        expect(adopted.identifier).toEqual(detached.identifier)
      }
    })
  }

  test('stores a record under the id it is given, keyed or not', () => {
    const adoptRecord = adopt(ReferencePlan.of([]))
    const keyed = detachFhir({ ...sample(Patient.Schema, 12), id: 'pat-7' })
    const keyless = detachFhir({ ...sample(Binary.Schema, 11), id: 'src-1' })
    expect(adoptRecord(keyed, 'planned-1').id).toBe('planned-1')
    expect(adoptRecord(keyless, 'planned-2').id).toBe('planned-2')
  })

  // The cornerstone: a reference has to land on exactly the id its target gets,
  // or `$everything` (`?subject=Patient/{id}`) stops resolving.
  test('a subject reference lands on the id its Patient, in the batch, is stored under', () => {
    const patientSource = { ...sample(Patient.Schema, 12), id: 'pat-7' }
    const patient = detachThenAdopt(patientSource)
    const observation = asObservation(
      detachThenAdopt(
        {
          ...sample(Observation.Schema, 13),
          id: 'obs-1',
          subject: reference({ reference: 'Patient/pat-7' }),
        },
        patientSource
      )
    )
    expect(observation.subject).toEqual(
      reference({
        reference: `Patient/${patient.id}`,
        type: 'Patient',
        identifier: identifier({ value: 'pat-7', system: new URL(fhirSystem('Patient')) }),
      })
    )
  })

  // Rexall's shape: a MedicationRequest and its MedicationDispense share one
  // source id, and the dispense links back to the request.
  test('a cross-type link resolves even when both sides share a source id', () => {
    const requestSource = { ...sample(MedicationRequest.Schema, 14), id: 'rx-1' }
    const request = detachThenAdopt(requestSource)
    const dispense = detachThenAdopt(
      {
        ...sample(MedicationDispense.Schema, 15),
        id: 'rx-1',
        authorizingPrescription: [reference({ reference: 'MedicationRequest/rx-1' })],
      },
      requestSource
    )
    if (dispense.resourceType !== 'MedicationDispense') {
      throw new Error('unreachable: adopted a MedicationDispense')
    }
    expect(dispense.id).not.toBe(request.id)
    expect(dispense.authorizingPrescription[0]?.reference).toBe(`MedicationRequest/${request.id}`)
  })

  // As a FHIR server leaves a conditional reference that matches nothing in
  // the transaction: the target was never served, so nothing is stored under
  // the id its key would derive, and the identity map gets the reference.
  test('leaves a reference to a record the batch does not hold logical', () => {
    const observation = asObservation(
      detachThenAdopt({
        ...sample(Observation.Schema, 13),
        id: 'obs-1',
        subject: reference({ reference: 'Patient/pat-9' }),
      })
    )
    expect(observation.subject).toEqual(
      reference({
        type: 'Patient',
        identifier: identifier({ value: 'pat-9', system: new URL(fhirSystem('Patient')) }),
      })
    )
  })

  test('leaves a logical reference by an identifier no record of the batch is keyed by as it is', () => {
    const account = reference({
      type: 'Patient',
      identifier: identifier({
        value: 'account-1',
        system: new URL('https://portal.example/fhir/identifier/customer-id'),
      }),
    })
    const person = detachFhir({ ...sample(Patient.Schema, 12), id: 'pat-7' })
    const observation = detachFhir({
      ...sample(Observation.Schema, 13),
      id: 'obs-1',
      subject: account,
    })
    expect(asObservation(adoptionOver([person, observation])(observation)).subject).toEqual(account)
  })

  for (const [label, logical] of [
    [
      'states no type',
      reference({
        identifier: identifier({ value: 'pat-7', system: new URL(fhirSystem('Patient')) }),
      }),
    ],
    [
      'states a type R4 does not define',
      reference({
        type: 'PrescriptionOrder',
        identifier: identifier({ value: 'pat-7', system: new URL(fhirSystem('Patient')) }),
      }),
    ],
    [
      'states a type that is a URI, not a resource type',
      reference({
        type: 'https://profiles.example/StructureDefinition/Thing',
        identifier: identifier({ value: 'pat-7', system: new URL(fhirSystem('Patient')) }),
      }),
    ],
    [
      'names its target by an identifier with no system',
      reference({ type: 'Patient', identifier: identifier({ value: 'pat-7' }) }),
    ],
    [
      'names its target by an identifier with no value',
      reference({
        type: 'Patient',
        identifier: identifier({ system: new URL(fhirSystem('Patient')) }),
      }),
    ],
  ] as const) {
    test(`leaves a logical reference that ${label} as it is`, () => {
      const person = detachFhir({ ...sample(Patient.Schema, 12), id: 'pat-7' })
      const observation = detachFhir({
        ...sample(Observation.Schema, 13),
        id: 'obs-1',
        subject: logical,
      })
      expect(asObservation(adoptionOver([person, observation])(observation)).subject).toEqual(
        logical
      )
    })
  }

  // A Binary has no identifier element, so nothing can name it by a key: a
  // reference to one never matches a record of the batch, and stays logical.
  test('leaves a reference to a keyless record of the batch logical', () => {
    const binarySource = { ...sample(Binary.Schema, 11), id: 'bin-1' }
    const document = detachThenAdopt(
      {
        ...sample(DocumentReference.Schema, 16),
        id: 'doc-1',
        relatesTo: [
          {
            id: null,
            extension: [],
            modifierExtension: [],
            code: 'appends',
            target: reference({ reference: 'Binary/bin-1' }),
          },
        ],
      },
      binarySource
    )
    if (document.resourceType !== 'DocumentReference') {
      throw new Error('unreachable: adopted a DocumentReference')
    }
    expect(document.relatesTo[0]?.target.reference).toBeNull()
  })

  test('resolves a logical reference the source wrote by key, when the batch holds its target', () => {
    const byKey = reference({
      type: 'Patient',
      identifier: identifier({ value: 'pat-7', system: new URL(fhirSystem('Patient')) }),
    })
    const person = detachFhir({ ...sample(Patient.Schema, 12), id: 'pat-7' })
    const observation = detachFhir({
      ...sample(Observation.Schema, 13),
      id: 'obs-1',
      subject: byKey,
    })
    expect(asObservation(adoptionOver([person, observation])(observation)).subject).toEqual({
      ...byKey,
      reference: `Patient/${localResourceId(fhirSystem('Patient'), 'Patient', 'pat-7')}`,
    })
  })

  // A CarePlan's `goal` and the Goal it names must land on the same local id,
  // or the plan loses its objectives on import.
  test('a CarePlan goal reference lands on the id its Goal is stored under', () => {
    const goalSource = { ...sample(Goal.Schema, 22), id: 'goal-7' }
    const goal = detachThenAdopt(goalSource)
    const plan = detachThenAdopt(
      {
        ...sample(CarePlan.Schema, 21),
        id: 'plan-1',
        goal: [reference({ reference: 'Goal/goal-7' })],
      },
      goalSource
    )
    if (plan.resourceType !== 'CarePlan') throw new Error('unreachable: adopted a CarePlan')

    expect(plan.goal[0]?.reference).toBe(`Goal/${goal.id}`)
  })

  // A workout `Procedure` carries out `ServiceRequest`s; its `basedOn` must
  // land on the ids those requests are stored under. Its performer's
  // organization and its device were never served, so they stay logical.
  test('resolves the references nested in a Procedure to records of the batch, and only those', () => {
    const requestSource = { ...sample(ServiceRequest.Schema, 19), id: 'sr-1' }
    const practitionerSource = { ...sample(Practitioner.Schema, 18), id: 'prac-1' }
    const adopted = detachThenAdopt(
      {
        ...sample(Procedure.Schema, 24),
        id: 'proc-1',
        basedOn: [reference({ reference: 'ServiceRequest/sr-1' })],
        performer: [
          {
            id: null,
            extension: [],
            modifierExtension: [],
            function: null,
            actor: reference({ reference: 'Practitioner/prac-1' }),
            onBehalfOf: reference({ reference: 'Organization/org-1' }),
          },
        ],
        focalDevice: [
          {
            id: null,
            extension: [],
            modifierExtension: [],
            action: null,
            manipulated: reference({ reference: 'Device/dev-1' }),
          },
        ],
      },
      requestSource,
      practitionerSource
    )
    if (adopted.resourceType !== 'Procedure') throw new Error('unreachable: adopted a Procedure')

    expect(adopted.basedOn[0]?.reference).toBe(
      `ServiceRequest/${detachThenAdopt(requestSource).id}`
    )
    expect(adopted.performer[0]?.actor.reference).toBe(
      `Practitioner/${detachThenAdopt(practitionerSource).id}`
    )
    expect(adopted.performer[0]?.onBehalfOf?.reference).toBeNull()
    expect(adopted.focalDevice[0]?.manipulated.reference).toBeNull()
  })
})

describe('detaching nested references', () => {
  /** The logical reference to the `resourceType` record {@link BASE} calls `id`. */
  const logicalTo = (resourceType: string, id: string): ReferenceType =>
    reference({
      type: resourceType,
      identifier: identifier({ value: id, system: new URL(fhirSystem(resourceType)) }),
    })

  // `CarePlan.activity` nests references two backbone levels down — including a
  // `product[x]` choice slot and the `progress` annotations' authors — so each
  // one is placed explicitly rather than left to whatever the sample generated.
  test('detaches every reference nested in a CarePlan activity and its detail', () => {
    const detail = {
      id: null,
      extension: [],
      modifierExtension: [],
      kind: null,
      instantiatesCanonical: [],
      instantiatesUri: [],
      code: null,
      reasonCode: [],
      reasonReference: [reference({ reference: 'Condition/cond-1' })],
      goal: [reference({ reference: 'Goal/goal-1' })],
      status: 'in-progress',
      statusReason: null,
      doNotPerform: null,
      scheduledTiming: null,
      scheduledPeriod: null,
      scheduledString: null,
      location: reference({ reference: 'Location/loc-1' }),
      performer: [reference({ reference: 'Practitioner/prac-1' })],
      productCodeableConcept: null,
      productReference: reference({ reference: 'Medication/med-1' }),
      dailyAmount: null,
      quantity: null,
      description: 'Walk 30 minutes daily',
    } as const satisfies typeof CarePlanActivityDetail.Schema.Type
    const detached = detachFhir<typeof CarePlan.Schema.Type>({
      ...sample(CarePlan.Schema, 21),
      id: 'plan-1',
      activity: [
        {
          id: null,
          extension: [],
          modifierExtension: [],
          outcomeCodeableConcept: [],
          outcomeReference: [reference({ reference: 'Observation/obs-1' })],
          progress: [
            {
              id: null,
              extension: [],
              authorReference: reference({ reference: 'Practitioner/prac-2' }),
              authorString: null,
              text: 'On track.',
              time: null,
            },
          ],
          reference: reference({ reference: 'ServiceRequest/sr-1' }),
          detail,
        },
      ],
    })
    if (detached.resourceType !== 'CarePlan') throw new Error('unreachable: detached a CarePlan')

    const [activity] = detached.activity
    expect(activity?.outcomeReference[0]).toEqual(logicalTo('Observation', 'obs-1'))
    expect(activity?.progress[0]?.authorReference).toEqual(logicalTo('Practitioner', 'prac-2'))
    expect(activity?.progress[0]?.text).toBe('On track.')
    expect(activity?.reference).toEqual(logicalTo('ServiceRequest', 'sr-1'))
    expect(activity?.detail?.reasonReference[0]).toEqual(logicalTo('Condition', 'cond-1'))
    expect(activity?.detail?.goal[0]).toEqual(logicalTo('Goal', 'goal-1'))
    expect(activity?.detail?.location).toEqual(logicalTo('Location', 'loc-1'))
    expect(activity?.detail?.performer[0]).toEqual(logicalTo('Practitioner', 'prac-1'))
    expect(activity?.detail?.productReference).toEqual(logicalTo('Medication', 'med-1'))
    expect(activity?.detail?.description).toBe('Walk 30 minutes daily')
  })

  // `PlanDefinition.action` nests itself, and the coverage guard reports its
  // references once, at the outermost path — so the rewrite at depth is
  // pinned here.
  test('detaches the subject of a PlanDefinition action at every depth', () => {
    const emptyAction = Schema.decodeSync(PlanDefinitionAction.Schema)({})
    const detached = detachFhir<typeof PlanDefinition.Schema.Type>({
      ...sample(PlanDefinition.Schema, 23),
      id: 'plan-1',
      action: [
        {
          ...emptyAction,
          subjectReference: reference({ reference: 'Group/outer' }),
          action: [{ ...emptyAction, subjectReference: reference({ reference: 'Group/inner' }) }],
        },
      ],
    })
    if (detached.resourceType !== 'PlanDefinition') {
      throw new Error('unreachable: detached a PlanDefinition')
    }

    const [outer] = detached.action
    expect(outer?.subjectReference).toEqual(logicalTo('Group', 'outer'))
    expect(outer?.action[0]?.subjectReference).toEqual(logicalTo('Group', 'inner'))
  })
})

describe('writing a record detached', () => {
  const encodeObservation = Schema.encodeSync(Observation.Schema)
  const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)
  const decodeDetachedObservation = DetachedResource.decodeUnknown(Observation.Schema)

  /** `observation`'s wire, with `id` and `subject` as given and its own identifiers kept. */
  const observationWire = (
    observation: typeof Observation.Schema.Type,
    fields: Record<string, unknown>
  ): Record<string, unknown> => {
    const { id: _id, subject: _subject, ...rest } = encodeObservation(observation)
    return { ...rest, ...fields }
  }

  // The parity a decoder that writes its records detached relies on: what it
  // writes is what `fromServerRecord` makes of the server-shaped record it stands for,
  // so the records it hands the import stage are stored exactly as before.
  // The wire is minimal on purpose: a sampled Observation carries literal
  // references of its own, which `fromServerRecord` rewrites and a direct write would
  // have to spell too.
  test('property: a key identifier and a logical reference read as detach writes them', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9\-.]{1,64}$/),
        fc.stringMatching(/^[A-Za-z0-9\-.]{1,64}$/),
        (observationId, patientId) => {
          const base = { resourceType: 'Observation', status: 'final', code: { text: 'Weight' } }
          const serverShaped = decodeObservation({
            ...base,
            id: observationId,
            subject: { reference: `Patient/${patientId}`, display: 'Avery' },
          })
          const writtenDetached = Effect.runSync(
            decodeDetachedObservation({
              ...base,
              identifier: [
                DetachedResource.keyIdentifierWire({
                  system: fhirSystem('Observation'),
                  value: observationId,
                }),
              ],
              subject: {
                ...DetachedResource.logicalReferenceWire('Patient', {
                  system: fhirSystem('Patient'),
                  value: patientId,
                }),
                display: 'Avery',
              },
            })
          )
          expect(writtenDetached).toEqual(detachFhir(serverShaped))
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('a wire that carries an id is not a detached record', () => {
    const wire = observationWire(sample(Observation.Schema, 13), { id: 'obs-1' })
    expect(Effect.runSync(Effect.either(decodeDetachedObservation(wire)))).toMatchObject({
      _tag: 'Left',
    })
  })

  test('a logical reference to a record of the batch adopts to its stored reference', () => {
    const decodePatient = DetachedResource.decodeUnknown(Patient.Schema)
    const key = { system: SYSTEM, value: 'pat-7' }
    const patient = Effect.runSync(
      decodePatient({
        resourceType: 'Patient',
        identifier: [DetachedResource.keyIdentifierWire(key)],
      })
    )
    const observation = Effect.runSync(
      decodeDetachedObservation(
        observationWire(sample(Observation.Schema, 13), {
          subject: DetachedResource.logicalReferenceWire('Patient', key),
        })
      )
    )
    expect(
      asObservation(adoptionOver([patient, observation])(observation)).subject?.reference
    ).toBe(DetachedResource.storedReferenceOf('Patient', key))
  })
})

describe('adoptedReferenceOf', () => {
  /** A record of `resourceType` its source calls `id`. */
  const targetOf = (resourceType: 'Patient' | 'Practitioner', id: string): FhirResource =>
    resourceType === 'Patient'
      ? { ...sample(Patient.Schema, 12), id }
      : { ...sample(Practitioner.Schema, 18), id }

  test('property: spells a reference as adopt resolves one to a record of the batch', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(BASE, 'https://other.example/fhir'),
        fc.constantFrom<'Patient' | 'Practitioner'>('Patient', 'Practitioner'),
        fc.stringMatching(/^[A-Za-z0-9\-.]{1,64}$/),
        (baseUrl, resourceType, originalId) => {
          const target = DetachedResource.fromServerRecord(baseUrl)(
            targetOf(resourceType, originalId)
          )
          const observation = DetachedResource.fromServerRecord(baseUrl)({
            ...sample(Observation.Schema, 13),
            id: 'obs-1',
            subject: reference({ reference: `${resourceType}/${originalId}` }),
          })
          expect(
            adoptedReferenceOf(`${baseUrl}/${resourceType}`, resourceType, originalId)
          ).toEqual(asObservation(adoptionOver([target, observation])(observation)).subject)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('originalIdOf', () => {
  test('reads the id a source gave a record back off it, in the system its server gives the type', () => {
    for (const resource of resources) {
      if (resource.resourceType === 'Binary') continue
      expect(originalIdOf(fhirSystem(resource.resourceType), detachThenAdopt(resource))).toBe(
        'src-1'
      )
    }
  })

  test('reads nothing off a Binary, which carries no identifiers', () => {
    expect(
      originalIdOf(
        fhirSystem('Binary'),
        detachThenAdopt({ ...sample(Binary.Schema, 11), id: 'src-1' })
      )
    ).toBeNull()
  })

  test('reads nothing off a record with no identifier in the system', () => {
    expect(
      originalIdOf(SYSTEM, detachThenAdopt({ ...sample(Observation.Schema, 13), id: 'src-1' }))
    ).toBeNull()
  })
})
