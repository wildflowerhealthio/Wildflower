import { Arbitrary, FastCheck as fc, SchemaAST, type Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import {
  IdentifierSchema,
  ReferenceSchema,
  type IdentifierType,
  type ReferenceType,
} from '../data-types/complex/identifier-and-reference.ts'
import {
  Binary,
  DiagnosticReport,
  DocumentReference,
  type FhirResource,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  Practitioner,
} from '../resources/index.ts'
import { adoptResource, originalIdOf, type SourceIdentity } from './adopt-resource.ts'
import { localResourceId } from './local-resource-id.ts'

/**
 * Covers adoption of a single resource: the derived id, the injected source
 * identifier, and the reference rewrite. Three failure modes this suite exists
 * to catch, each of which loses data silently:
 *
 * - identifiers the source already carried being clobbered (asserted by value,
 *   never by reference);
 * - fields outside the reference table being blanked or invented (asserted by
 *   diffing everything the table does *not* name);
 * - the rewrite accepting reference strings that are not relative references
 *   (a `#fragment`, a `urn:uuid:`, an id with a space).
 *
 * Resources come from each schema's own arbitrary rather than hand-rolled
 * shapes, so every field is populated with something — a hand-built shell would
 * leave the "did adoption blank it?" question unasked for whatever the author
 * forgot to fill in.
 */

const SOURCE: SourceIdentity = {
  system: 'https://source.example/baseR4',
  baseUrl: 'https://source.example/baseR4',
}

/** A source whose references are always relative — no `baseUrl`. */
const RELATIVE_SOURCE: SourceIdentity = {
  system: 'https://wildflowerhealth.io/fhir/sid/example-portal',
}

const adopt = adoptResource(SOURCE)

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
 * Every field adoption is permitted to touch, per resource type. This table is
 * the contract; the "no collateral change" property below diffs everything
 * *not* named here.
 */
const ADOPTED_FIELDS = {
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
} as const satisfies Record<FhirResource['resourceType'], readonly string[]>

// ---------------------------------------------------------------------------
// Schema-derived reference coverage.
//
// The complement diff above cannot catch a `Reference` missing from *both* the
// implementation and `ADOPTED_FIELDS`: adoption leaves it alone, and that
// property asserts precisely that it was left alone. The guard below closes that
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
// it forces a `Suspend`, so `node === ReferenceSchema.ast` is false for the very
// occurrences this needs to find.
const REFERENCE_SHAPE = declaredShapeOf(ReferenceSchema.ast)
const IDENTIFIER_SHAPE = declaredShapeOf(IdentifierSchema.ast)

/**
 * Every dotted path at which a resource schema declares a `Reference`.
 *
 * @remarks
 * Stops at a `Reference` (that is the find) and at an `Identifier` — whose
 * `assigner` adoption never rewrites, wherever it is reached from. Those two
 * stops also break the `Reference` ⇄ `Identifier` cycle.
 *
 * Throws rather than truncating at {@link MAX_WALK_DEPTH}: a silently-cut walk
 * reports *fewer* references than exist, which is the failure this guard exists
 * to prevent.
 */
const referencePathsIn = (schema: { readonly ast: SchemaAST.AST }): readonly string[] => {
  const found: string[] = []
  const walk = (node: SchemaAST.AST, path: readonly string[], depth: number): void => {
    if (depth > MAX_WALK_DEPTH) {
      throw new Error(`reference walk exceeded ${MAX_WALK_DEPTH} at ${path.join('.')}`)
    }
    const shape = shapeOf(node)
    if (shape !== '' && shape === REFERENCE_SHAPE) {
      found.push(path.join('.'))
      return
    }
    if (shape !== '' && shape === IDENTIFIER_SHAPE) return
    if (SchemaAST.isSuspend(node)) return walk(node.f(), path, depth + 1)
    if (SchemaAST.isTypeLiteral(node)) {
      for (const property of node.propertySignatures) {
        const name = String(property.name)
        if (!EXEMPT_SUBTREES.has(name)) walk(property.type, [...path, name], depth + 1)
      }
      return
    }
    if (SchemaAST.isUnion(node)) {
      for (const member of node.types) walk(member, path, depth + 1)
      return
    }
    if (SchemaAST.isTupleType(node)) {
      for (const element of node.elements) walk(element.type, path, depth + 1)
      for (const rest of node.rest) walk(rest.type, path, depth + 1)
      return
    }
    if (SchemaAST.isTransformation(node)) return walk(node.to, path, depth + 1)
    if (SchemaAST.isRefinement(node)) return walk(node.from, path, depth + 1)
    // `OrNullAsOptional` is a `Declaration` wrapping the real schema, so the
    // inner type hides in its type parameters rather than under a `from`/`to`.
    if (SchemaAST.isDeclaration(node)) {
      for (const parameter of node.typeParameters) walk(parameter, path, depth + 1)
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
 * hiding behind a top-level field already in `ADOPTED_FIELDS`.
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
    // The load-bearing one. A `Reference` field added to a resource schema and
    // to neither table lands on the left of this comparison and nowhere on the
    // right, and fails here — instead of shipping a reference that keeps the
    // source's id and dangles.
    test(`${resourceType}: every Reference the schema declares is rewritten or exempt`, () => {
      expect(referencePathsIn(SCHEMA_FOR[resourceType])).toEqual(
        [...REWRITTEN_REFERENCE_PATHS[resourceType]].toSorted()
      )
    })

    // Ties the dotted table to the flat one, so the "no collateral change"
    // property above cannot go stale against it.
    test(`${resourceType}: every rewritten path is rooted in an adopted field`, () => {
      const roots = new Set(
        REWRITTEN_REFERENCE_PATHS[resourceType].map((path) => path.split('.')[0])
      )
      expect([...roots].toSorted()).toEqual(
        ADOPTED_FIELDS[resourceType]
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

/** Every own field of `resource` except the ones adoption may rewrite. */
const untouchedFields = (resource: FhirResource): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(resource).filter(
      ([key]) => !ADOPTED_FIELDS[resource.resourceType].some((field) => field === key)
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
]

describe('adoptResource', () => {
  for (const resource of resources) {
    const { resourceType } = resource

    test(`${resourceType}: derives the local id`, () => {
      expect(adopt(resource).id).toBe(localResourceId(SOURCE.system, resourceType, 'src-1'))
    })

    // The whole point of diffing the complement of the table: a rewrite that
    // spread a stale copy, or blanked a field it did not mean to name, shows up
    // here rather than passing unnoticed because no assertion mentioned it.
    test(`${resourceType}: changes nothing outside the reference table`, () => {
      const adopted = adopt(resource)
      expect(Object.keys(adopted).toSorted()).toEqual(Object.keys(resource).toSorted())
      expect(untouchedFields(adopted)).toEqual(untouchedFields(resource))
    })

    test(`${resourceType}: leaves contained byte-untouched`, () => {
      // `contained` is raw passthrough JSON — a decoded Identifier injected in
      // there would write `null`s onto the wire.
      const adopted = adopt(resource)
      if ('contained' in adopted && 'contained' in resource) {
        expect(adopted.contained).toBe(resource.contained)
      }
    })

    test(`${resourceType}: passes a null-id resource straight through`, () => {
      const idLess = { ...resource, id: null }
      expect(adopt(idLess)).toBe(idLess)
    })
  }

  test('keeps every identifier the source already carried, and prepends its own', () => {
    const existing = [
      identifier({ value: 'mrn-9', system: new URL('https://source.example/sid/mrn') }),
      identifier({ value: 'ohip-4' }),
    ]
    const adopted = adopt({ ...sample(Patient.Schema, 12), id: 'src-1', identifier: existing })
    if (adopted.resourceType !== 'Patient') throw new Error('unreachable: adopted a Patient')

    expect(adopted.identifier[0]).toEqual(
      identifier({ value: 'src-1', system: new URL(SOURCE.system) })
    )
    // Compared by value. Adoption necessarily builds a new array, so there is
    // no reference to assert on — and an implementation that rebuilt it from a
    // stale copy of the resource would be caught only by the contents.
    expect(adopted.identifier.slice(1)).toEqual(existing)
  })

  test('Binary is adopted but gets no identifier — R4 gives it none', () => {
    const binary = { ...sample(Binary.Schema, 11), id: 'src-1' }
    const adopted = adopt(binary)
    expect(adopted.id).toBe(localResourceId(SOURCE.system, 'Binary', 'src-1'))
    expect('identifier' in adopted).toBe(false)
    expect(originalIdOf(SOURCE, adopted)).toBeNull()
  })

  test('round-trips the source id back off every non-Binary resource', () => {
    for (const resource of resources) {
      if (resource.resourceType === 'Binary') continue
      expect(originalIdOf(SOURCE, adopt(resource))).toBe('src-1')
    }
  })

  test('reads no source id off a resource adopted under a different source', () => {
    const adopted = adopt({ ...sample(Observation.Schema, 13), id: 'src-1' })
    expect(originalIdOf(RELATIVE_SOURCE, adopted)).toBeNull()
  })

  test('reads no source id off a resource that was never adopted', () => {
    const raw = { ...sample(Observation.Schema, 13), id: 'src-1', identifier: [] }
    expect(originalIdOf(SOURCE, raw)).toBeNull()
  })
})

describe('reference rewriting', () => {
  const observationWith = (subject: ReferenceType): typeof Observation.Schema.Type => ({
    ...sample(Observation.Schema, 13),
    id: 'obs-1',
    subject,
  })

  const subjectOf = (source: SourceIdentity, subject: ReferenceType): ReferenceType | null => {
    const adopted = adoptResource(source)(observationWith(subject))
    if (adopted.resourceType !== 'Observation') throw new Error('unreachable: adopted Observation')
    return adopted.subject
  }

  // The cornerstone: a reference has to land on exactly the id its target gets,
  // or `$everything` (`?subject=Patient/{id}`) stops resolving.
  test('a subject reference lands on the id its Patient is adopted to', () => {
    const patient = adopt({ ...sample(Patient.Schema, 12), id: 'pat-7' })
    expect(subjectOf(SOURCE, reference({ reference: 'Patient/pat-7' }))?.reference).toBe(
      `Patient/${patient.id}`
    )
  })

  // Rexall's shape: a MedicationRequest and its MedicationDispense share one
  // source id, and the dispense links back to the request.
  test('a cross-type link resolves even when both sides share a source id', () => {
    const request = adopt({ ...sample(MedicationRequest.Schema, 14), id: 'rx-1' })
    const dispense = adopt({
      ...sample(MedicationDispense.Schema, 15),
      id: 'rx-1',
      authorizingPrescription: [reference({ reference: 'MedicationRequest/rx-1' })],
    })
    if (dispense.resourceType !== 'MedicationDispense') {
      throw new Error('unreachable: adopted a MedicationDispense')
    }
    expect(dispense.id).not.toBe(request.id)
    expect(dispense.authorizingPrescription[0]?.reference).toBe(`MedicationRequest/${request.id}`)
  })

  test('records the original target id on the reference when the slot is free', () => {
    expect(subjectOf(SOURCE, reference({ reference: 'Patient/pat-7' }))?.identifier).toEqual(
      identifier({ value: 'pat-7', system: new URL(SOURCE.system) })
    )
  })

  // `Reference.identifier` is 0..1 and some dialects already fill it with a
  // vendor id. Stealing that slot would discard a real identifier; the original
  // `Type/id` stays recoverable through the rewritten target instead.
  test('never steals a Reference.identifier the source already filled', () => {
    const vendor = identifier({ value: 'pharmacy-4821' })
    const rewritten = subjectOf(
      SOURCE,
      reference({ reference: 'Patient/pat-7', identifier: vendor })
    )
    expect(rewritten?.identifier).toEqual(vendor)
    expect(rewritten?.reference).not.toBe('Patient/pat-7')
  })

  test('rewrites an absolute self-reference exactly as its relative spelling', () => {
    const relative = subjectOf(SOURCE, reference({ reference: 'Patient/pat-7' }))
    const absolute = subjectOf(
      SOURCE,
      reference({ reference: 'https://source.example/baseR4/Patient/pat-7' })
    )
    expect(absolute).toEqual(relative)
  })

  test('leaves an absolute reference alone when the source declares no baseUrl', () => {
    const target = 'https://source.example/baseR4/Patient/pat-7'
    expect(subjectOf(RELATIVE_SOURCE, reference({ reference: target }))?.reference).toBe(target)
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
      expect(subjectOf(SOURCE, original)).toEqual(original)
    })
  }

  test('leaves an identifier-only reference untouched', () => {
    const original = reference({ identifier: identifier({ value: 'only-an-identifier' }) })
    expect(subjectOf(SOURCE, original)).toEqual(original)
  })

  test('rewrites a type this package does not store, so the link resolves if it is ever imported', () => {
    expect(subjectOf(SOURCE, reference({ reference: 'Organization/org-3' }))?.reference).toBe(
      `Organization/${localResourceId(SOURCE.system, 'Organization', 'org-3')}`
    )
  })

  // Found by the schema-derived coverage guard above, not by reading the spec:
  // `Annotation.author[x]` is a Reference when it is not the string variant, and
  // it sits one level down inside an array, which is why a manual walk missed it.
  test('rewrites the author of a note, one level down inside an array', () => {
    const adopted = adopt({
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
    if (adopted.resourceType !== 'Observation') throw new Error('unreachable: adopted Observation')

    expect(adopted.note[0]?.authorReference?.reference).toBe(
      `Practitioner/${localResourceId(SOURCE.system, 'Practitioner', 'prac-3')}`
    )
    // The rest of the note is carried, not rebuilt.
    expect(adopted.note[0]?.text).toBe('Reviewed with the patient.')
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
    const adopted = adopt({ ...sample(Observation.Schema, 13), id: 'obs-1', note: [note] })
    if (adopted.resourceType !== 'Observation') throw new Error('unreachable: adopted Observation')

    expect(adopted.note[0]).toEqual(note)
  })

  // The standing exemption the coverage guard encodes by stopping at every
  // `Identifier`: `Identifier.assigner` is a Reference, and adoption leaves it
  // exactly as the source sent it.
  test('never rewrites the assigner of an Identifier', () => {
    const assigner = reference({ reference: 'Organization/org-2' })
    const adopted = adopt({
      ...sample(Patient.Schema, 12),
      id: 'src-1',
      identifier: [identifier({ value: 'mrn-9', assigner })],
    })
    if (adopted.resourceType !== 'Patient') throw new Error('unreachable: adopted a Patient')

    expect(adopted.identifier[1]?.assigner).toEqual(assigner)
  })
})
