import { Effect, Option, ParseResult, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { type FhirResource, Patient } from '../resources/index.ts'
import { originalIdOf, type SourceIdentity } from './adopt-resource.ts'
import { adoptSourceIdentity, adoptUnderRecognizedRoot } from './adopt-source-identity.ts'
import { localResourceId } from './local-resource-id.ts'

/**
 * Covers the two adoption combinators: the plan-level `adoptSourceIdentity`
 * (what it rewrites, what it leaves alone, and the memo that keeps two plans
 * deep-equal) and the per-kind `adoptUnderRecognizedRoot` (identity read
 * verbatim off `tryRecognize`, the unrecognized-URL `ParseError` arm, and
 * referential stability).
 *
 * The plan and entity shapes here are plain objects rather than
 * `collector-fundamentals` / `http-extraction-fundamentals` values — `fhir-r4` sits below both slices and
 * names both structurally, so the suite exercises exactly the surface the
 * combinators claim.
 */

const SOURCE: SourceIdentity = { system: 'https://source.example/baseR4' }

const patient = (id: string | null): typeof Patient.Schema.Type =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A `tryRecognize` claiming a `…/Patient` URL, minting no identity of its own. */
const recognizesPatient = (
  url: string
): Option.Option<{ readonly specificity: number; readonly source?: SourceIdentity }> =>
  url.endsWith('/Patient') ? Option.some({ specificity: 50 }) : Option.none()

const followUpSteps = (): readonly unknown[] => []

const captureProvenance = (): Effect.Effect<never> => Effect.never

/** A module-singleton entity, as every real entity is. */
const entity = {
  name: 'PatientResponseKind',
  tryRecognize: recognizesPatient,
  parse: (_response: {
    readonly url: string
  }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
    Effect.succeed([patient('src-1')]),
  followUpSteps,
}

const failing = {
  name: 'FailingEntity',
  tryRecognize: recognizesPatient,
  parse: (_response: {
    readonly url: string
  }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
    Effect.fail(new ParseResult.ParseError({ issue: new ParseResult.Type(Patient.Schema.ast, 1) })),
}

const stepSequence = [{ _tag: 'Delay', name: 'wait' }] as const

const plan = {
  name: 'Example',
  responseKinds: [entity],
  stepSequence,
  captureProvenance,
}

/**
 * An entity that declares it parses only `Patient`, as a collector's own
 * entities do before the plan widens them.
 */
const narrowEntity = {
  name: 'NarrowPatientResponseKind',
  tryRecognize: recognizesPatient,
  parse: (_response: {
    readonly url: string
  }): Effect.Effect<readonly (typeof Patient.Schema.Type)[], ParseResult.ParseError> =>
    Effect.succeed([patient('src-1')]),
}

const narrowPlan = { ...plan, responseKinds: [narrowEntity] }

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
    expect(adoptSourceIdentity(SOURCE)({ ...plan, responseKinds: widened })).toBeDefined()
    expect(typeof refused).toBe('function')
  })

  test('adopts what the entities parse', async () => {
    const [wrapped] = adoptSourceIdentity(SOURCE)(plan).responseKinds
    if (wrapped === undefined) throw new Error('unreachable: one entity')
    const [resource] = await Effect.runPromise(wrapped.parse({ url: 'https://x/Patient' }))
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
    const [wrapped] = adoptSourceIdentity(SOURCE)(plan).responseKinds
    expect(wrapped?.name).toBe(entity.name)
    expect(wrapped?.tryRecognize).toBe(entity.tryRecognize)
    expect(wrapped?.followUpSteps).toBe(entity.followUpSteps)
    expect(wrapped?.parse).not.toBe(entity.parse)
  })

  // Load-bearing: per-collector suites deep-equal two plans built from one
  // config, and `toEqual` compares functions by identity. A combinator that
  // minted a fresh closure per call would break every one of them.
  test('mints one parse wrapper per (source, entity), so two builds deep-equal', () => {
    const first = adoptSourceIdentity(SOURCE)(plan)
    const second = adoptSourceIdentity({ system: SOURCE.system })(plan)
    expect(first.responseKinds[0]?.parse).toBe(second.responseKinds[0]?.parse)
    expect(first).toEqual(second)
  })

  test('wraps separately per source system', () => {
    const first = adoptSourceIdentity(SOURCE)(plan)
    const other = adoptSourceIdentity({ system: 'https://other.example/fhir' })(plan)
    expect(first.responseKinds[0]?.parse).not.toBe(other.responseKinds[0]?.parse)
  })

  test('wraps separately when only baseUrl differs', () => {
    const bare = adoptSourceIdentity(SOURCE)(plan)
    const based = adoptSourceIdentity({ ...SOURCE, baseUrl: SOURCE.system })(plan)
    expect(bare.responseKinds[0]?.parse).not.toBe(based.responseKinds[0]?.parse)
  })

  test('passes a parse failure through untouched — the error channel is unchanged', async () => {
    const adopted = adoptSourceIdentity(SOURCE)({ ...plan, responseKinds: [failing] })
    const result = await Effect.runPromise(
      Effect.either(adopted.responseKinds[0].parse({ url: 'https://x/Patient' }))
    )
    expect(result._tag).toBe('Left')
  })

  // Adoption runs inside `Effect.map` only, so a synchronous parse stays
  // synchronously runnable — the collector's sync runner depends on it.
  test('keeps a synchronous parse synchronously runnable', () => {
    const [wrapped] = adoptSourceIdentity(SOURCE)(plan).responseKinds
    if (wrapped === undefined) throw new Error('unreachable: one entity')
    expect(Effect.runSync(wrapped.parse({ url: 'https://x/Patient' }))[0]?.id).toBe(
      localResourceId(SOURCE.system, 'Patient', 'src-1')
    )
  })

  test('freezes the returned plan and its entities', () => {
    const adopted = adoptSourceIdentity(SOURCE)(plan)
    expect(Object.isFrozen(adopted)).toBe(true)
    expect(Object.isFrozen(adopted.responseKinds)).toBe(true)
    expect(Object.isFrozen(adopted.responseKinds[0])).toBe(true)
  })

  test('passes an id-less resource through rather than inventing an identity', async () => {
    const idLess = {
      name: 'IdLessEntity',
      tryRecognize: recognizesPatient,
      parse: (_response: {
        readonly url: string
      }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
        Effect.succeed([patient(null)]),
    }
    const adopted = adoptSourceIdentity(SOURCE)({ ...plan, responseKinds: [idLess] })
    const [resource] = await Effect.runPromise(adopted.responseKinds[0].parse({ url: 'https://x' }))
    expect(resource?.id).toBeNull()
  })
})

// Helpers — the per-kind combinator's entities recognize a `…/Patient` URL and
// mint an identity off it, so the wrapper reads the source verbatim.
const ROOT = 'https://ehr.example/baseR4'

/** A kind whose `tryRecognize` mints a source WITH a `baseUrl` (a FHIR root). */
const rootedKind = {
  name: 'RootedKind',
  tryRecognize: (
    url: string
  ): Option.Option<{ readonly specificity: number; readonly source?: SourceIdentity }> =>
    url.endsWith('/Patient')
      ? Option.some({ specificity: 50, source: { system: ROOT, baseUrl: ROOT } })
      : Option.none(),
  parse: (_response: {
    readonly url: string
  }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
    Effect.succeed([patient('src-9')]),
}

const SID = 'https://wildflowerhealth.io/fhir/sid/portal'

/** A kind whose `tryRecognize` mints a source with NO `baseUrl` (a portal sid). */
const sidKind = {
  name: 'SidKind',
  tryRecognize: (
    url: string
  ): Option.Option<{ readonly specificity: number; readonly source?: SourceIdentity }> =>
    url.endsWith('/Patient')
      ? Option.some({ specificity: 100, source: { system: SID } })
      : Option.none(),
  parse: (_response: {
    readonly url: string
  }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
    Effect.succeed([patient('src-9')]),
}

/** A kind that recognizes but mints no source — must refuse adoption. */
const noSourceKind = {
  name: 'NoSourceKind',
  tryRecognize: (
    url: string
  ): Option.Option<{ readonly specificity: number; readonly source?: SourceIdentity }> =>
    url.endsWith('/Patient') ? Option.some({ specificity: 0 }) : Option.none(),
  parse: (_response: {
    readonly url: string
  }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
    Effect.succeed([patient('src-9')]),
}

const adoptedRooted = adoptUnderRecognizedRoot(rootedKind)

describe('adoptUnderRecognizedRoot', () => {
  test('refuses a kind whose parse declares less than the whole FhirResource union', () => {
    // @ts-expect-error the kind parses only Patient, so the passthrough would lie
    const refused = (): unknown => adoptUnderRecognizedRoot(narrowEntity)
    expect(typeof refused).toBe('function')
  })

  test('adopts under the recognized source when it carries a baseUrl', async () => {
    const [resource] = await Effect.runPromise(adoptedRooted.parse({ url: `${ROOT}/Patient` }))
    expect(resource?.id).toBe(localResourceId(ROOT, 'Patient', 'src-9'))
    expect(resource === undefined ? null : originalIdOf({ system: ROOT }, resource)).toBe('src-9')
  })

  test('adopts under a source with no baseUrl (a portal sid)', async () => {
    const adopted = adoptUnderRecognizedRoot(sidKind)
    const [resource] = await Effect.runPromise(adopted.parse({ url: 'https://portal/Patient' }))
    expect(resource?.id).toBe(localResourceId(SID, 'Patient', 'src-9'))
  })

  test('fails with a ParseError when the URL is not recognized', async () => {
    const result = await Effect.runPromise(
      Effect.either(adoptedRooted.parse({ url: 'https://ehr.example/Observation/1' }))
    )
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') throw new Error('expected a Left')
    expect(result.left._tag).toBe('ParseError')
  })

  test('fails with a ParseError when the kind recognizes but mints no source', async () => {
    const adopted = adoptUnderRecognizedRoot(noSourceKind)
    const result = await Effect.runPromise(
      Effect.either(adopted.parse({ url: 'https://portal/Patient' }))
    )
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') throw new Error('expected a Left')
    expect(result.left._tag).toBe('ParseError')
  })

  test('leaves every field but parse at its original reference', () => {
    expect(adoptedRooted.name).toBe(rootedKind.name)
    expect(adoptedRooted.tryRecognize).toBe(rootedKind.tryRecognize)
    expect(adoptedRooted.parse).not.toBe(rootedKind.parse)
  })

  test('is a stable module constant — two reads of its parse are identical', () => {
    // No memo and no source parameter, so one application at module load is the
    // whole story: reading the constant twice yields the same frozen wrapper.
    expect(adoptedRooted.parse).toBe(adoptedRooted.parse)
    expect(Object.isFrozen(adoptedRooted)).toBe(true)
  })
})
