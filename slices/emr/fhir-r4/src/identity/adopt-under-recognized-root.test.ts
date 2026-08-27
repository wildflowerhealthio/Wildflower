import { Effect, Option, ParseResult, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { type FhirResource, Patient } from '../resources/index.ts'
import { originalIdOf, type SourceIdentity } from './adopt-resource.ts'
import { adoptUnderRecognizedRoot } from './adopt-under-recognized-root.ts'
import { localResourceId } from './local-resource-id.ts'

/**
 * Covers the per-kind `adoptUnderRecognizedRoot`: the identity is read verbatim
 * off `tryRecognize` (both a source carrying a `baseUrl` and one without), the
 * two failing arms (an unrecognized URL and a recognized-but-source-less kind),
 * the guard rejecting a kind that parses less than the whole `FhirResource`
 * union, and the referential stability of a single module-level application.
 *
 * The entity shapes here are plain objects rather than
 * `collector-fundamentals` / `http-extraction-fundamentals` values — `fhir-r4`
 * sits below both slices and names both structurally, so the suite exercises
 * exactly the surface the combinator claims.
 */

const patient = (id: string | null): typeof Patient.Schema.Type =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A `tryRecognize` claiming a `…/Patient` URL, minting no identity of its own. */
const recognizesPatient = (
  url: string
): Option.Option<{ readonly specificity: number; readonly source?: SourceIdentity }> =>
  url.endsWith('/Patient') ? Option.some({ specificity: 50 }) : Option.none()

/**
 * An entity that declares it parses only `Patient`, as a collector's own
 * entities do before the kind list is widened.
 */
const narrowEntity = {
  name: 'NarrowPatientResponseKind',
  tryRecognize: recognizesPatient,
  parse: (_response: {
    readonly url: string
  }): Effect.Effect<readonly (typeof Patient.Schema.Type)[], ParseResult.ParseError> =>
    Effect.succeed([patient('src-1')]),
}

// The per-kind combinator's entities recognize a `…/Patient` URL and mint an
// identity off it, so the wrapper reads the source verbatim.
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

  test('passes a parse failure through untouched — the error channel is unchanged', async () => {
    const failing = {
      name: 'FailingKind',
      tryRecognize: (
        url: string
      ): Option.Option<{ readonly specificity: number; readonly source?: SourceIdentity }> =>
        url.endsWith('/Patient')
          ? Option.some({ specificity: 50, source: { system: ROOT, baseUrl: ROOT } })
          : Option.none(),
      parse: (_response: {
        readonly url: string
      }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError> =>
        Effect.fail(
          new ParseResult.ParseError({ issue: new ParseResult.Type(Patient.Schema.ast, 1) })
        ),
    }
    const adopted = adoptUnderRecognizedRoot(failing)
    const result = await Effect.runPromise(Effect.either(adopted.parse({ url: `${ROOT}/Patient` })))
    expect(result._tag).toBe('Left')
  })

  // Adoption runs inside `Effect.map` only, so a synchronous parse stays
  // synchronously runnable — the collector's sync runner depends on it.
  test('keeps a synchronous parse synchronously runnable', () => {
    expect(Effect.runSync(adoptedRooted.parse({ url: `${ROOT}/Patient` }))[0]?.id).toBe(
      localResourceId(ROOT, 'Patient', 'src-9')
    )
  })

  test('is a stable module constant — two reads of its parse are identical', () => {
    // No memo and no source parameter, so one application at module load is the
    // whole story: reading the constant twice yields the same frozen wrapper.
    expect(adoptedRooted.parse).toBe(adoptedRooted.parse)
    expect(Object.isFrozen(adoptedRooted)).toBe(true)
  })
})
