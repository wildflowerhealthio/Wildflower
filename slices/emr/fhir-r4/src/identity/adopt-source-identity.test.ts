import { Effect, ParseResult, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { type FhirResource, Patient } from '../resources/index.ts'
import { originalIdOf, type SourceIdentity } from './adopt-resource.ts'
import { adoptSourceIdentity } from './adopt-source-identity.ts'
import { localResourceId } from './local-resource-id.ts'

/**
 * Covers the plan-level combinator: what it rewrites (entity `parse` output),
 * what it must leave alone (everything else, by reference), and the memo that
 * keeps two plans built from one config deep-equal.
 *
 * The plan and entity shapes here are plain objects rather than
 * `collector-fundamentals` / `http-extraction-fundamentals` values — `fhir-r4` sits below both slices and
 * names both structurally, so the suite exercises exactly the surface the
 * combinator claims.
 */

const SOURCE: SourceIdentity = { system: 'https://source.example/baseR4' }

const patient = (id: string | null): typeof Patient.Schema.Type =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

const isFoundAt = (url: string): boolean => url.endsWith('/Patient')

const followUpSteps = (): readonly unknown[] => []

const captureProvenance = (): Effect.Effect<never> => Effect.never

/** A module-singleton entity, as every real entity is. */
const entity = {
  name: 'PatientEntity',
  isFoundAt,
  parse: (_response: string): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
    Effect.succeed([patient('src-1')]),
  followUpSteps,
}

const failing = {
  name: 'FailingEntity',
  isFoundAt,
  parse: (_response: string): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
    Effect.fail(new ParseResult.ParseError({ issue: new ParseResult.Type(Patient.Schema.ast, 1) })),
}

const stepSequence = [{ _tag: 'Delay', name: 'wait' }] as const

const plan = {
  name: 'Example',
  entityDefinitions: [entity],
  stepSequence,
  captureProvenance,
}

/**
 * An entity that declares it parses only `Patient`, as a collector's own
 * entities do before the plan widens them.
 */
const narrowEntity = {
  name: 'NarrowPatientEntity',
  isFoundAt,
  parse: (
    _response: string
  ): Effect.Effect<readonly (typeof Patient.Schema.Type)[], ParseResult.ParseError> =>
    Effect.succeed([patient('src-1')]),
}

const narrowPlan = { ...plan, entityDefinitions: [narrowEntity] }

describe('adoptSourceIdentity', () => {
  // The combinator hands `TPlan` back unchanged, which is only truthful when the
  // entities already declare the whole union: adoption widens to `FhirResource`
  // and cannot be declared not to. So a narrower plan is refused at compile time
  // rather than silently misdeclared. `@ts-expect-error` is the assertion — this
  // file fails to typecheck if the guard stops rejecting it.
  test('refuses a plan whose entities declare less than the whole FhirResource union', () => {
    // @ts-expect-error the entities parse only Patient, so the passthrough would lie
    const refused = (): unknown => adoptSourceIdentity(SOURCE)(narrowPlan)

    // Widening the entity list is the fix, and it compiles.
    const widened: readonly (typeof entity)[] = [entity]
    expect(adoptSourceIdentity(SOURCE)({ ...plan, entityDefinitions: widened })).toBeDefined()
    expect(typeof refused).toBe('function')
  })

  test('adopts what the entities parse', async () => {
    const [wrapped] = adoptSourceIdentity(SOURCE)(plan).entityDefinitions
    if (wrapped === undefined) throw new Error('unreachable: one entity')
    const [resource] = await Effect.runPromise(wrapped.parse('body'))
    expect(resource?.id).toBe(localResourceId(SOURCE.system, 'Patient', 'src-1'))
    expect(resource === undefined ? null : originalIdOf(SOURCE, resource)).toBe('src-1')
  })

  test('leaves every other plan field at its original reference', () => {
    const adopted = adoptSourceIdentity(SOURCE)(plan)
    expect(adopted.stepSequence).toBe(plan.stepSequence)
    expect(adopted.captureProvenance).toBe(plan.captureProvenance)
    expect(adopted.name).toBe(plan.name)
  })

  test('leaves every entity field but parse at its original reference', () => {
    const [wrapped] = adoptSourceIdentity(SOURCE)(plan).entityDefinitions
    expect(wrapped?.name).toBe(entity.name)
    expect(wrapped?.isFoundAt).toBe(entity.isFoundAt)
    expect(wrapped?.followUpSteps).toBe(entity.followUpSteps)
    expect(wrapped?.parse).not.toBe(entity.parse)
  })

  // Load-bearing: per-collector suites deep-equal two plans built from one
  // config, and `toEqual` compares functions by identity. A combinator that
  // minted a fresh closure per call would break every one of them.
  test('mints one parse wrapper per (source, entity), so two builds deep-equal', () => {
    const first = adoptSourceIdentity(SOURCE)(plan)
    const second = adoptSourceIdentity({ system: SOURCE.system })(plan)
    expect(first.entityDefinitions[0]?.parse).toBe(second.entityDefinitions[0]?.parse)
    expect(first).toEqual(second)
  })

  test('wraps separately per source system', () => {
    const first = adoptSourceIdentity(SOURCE)(plan)
    const other = adoptSourceIdentity({ system: 'https://other.example/fhir' })(plan)
    expect(first.entityDefinitions[0]?.parse).not.toBe(other.entityDefinitions[0]?.parse)
  })

  test('wraps separately when only baseUrl differs', () => {
    const bare = adoptSourceIdentity(SOURCE)(plan)
    const based = adoptSourceIdentity({ ...SOURCE, baseUrl: SOURCE.system })(plan)
    expect(bare.entityDefinitions[0]?.parse).not.toBe(based.entityDefinitions[0]?.parse)
  })

  test('passes a parse failure through untouched — the error channel is unchanged', async () => {
    const adopted = adoptSourceIdentity(SOURCE)({ ...plan, entityDefinitions: [failing] })
    const result = await Effect.runPromise(
      Effect.either(adopted.entityDefinitions[0].parse('body'))
    )
    expect(result._tag).toBe('Left')
  })

  // Adoption runs inside `Effect.map` only, so a synchronous parse stays
  // synchronously runnable — the collector's sync runner depends on it.
  test('keeps a synchronous parse synchronously runnable', () => {
    const [wrapped] = adoptSourceIdentity(SOURCE)(plan).entityDefinitions
    if (wrapped === undefined) throw new Error('unreachable: one entity')
    expect(Effect.runSync(wrapped.parse('body'))[0]?.id).toBe(
      localResourceId(SOURCE.system, 'Patient', 'src-1')
    )
  })

  test('freezes the returned plan and its entities', () => {
    const adopted = adoptSourceIdentity(SOURCE)(plan)
    expect(Object.isFrozen(adopted)).toBe(true)
    expect(Object.isFrozen(adopted.entityDefinitions)).toBe(true)
    expect(Object.isFrozen(adopted.entityDefinitions[0])).toBe(true)
  })

  test('passes an id-less resource through rather than inventing an identity', async () => {
    const idLess = {
      name: 'IdLessEntity',
      isFoundAt,
      parse: (_response: string): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
        Effect.succeed([patient(null)]),
    }
    const adopted = adoptSourceIdentity(SOURCE)({ ...plan, entityDefinitions: [idLess] })
    const [resource] = await Effect.runPromise(adopted.entityDefinitions[0].parse('body'))
    expect(resource?.id).toBeNull()
  })
})
