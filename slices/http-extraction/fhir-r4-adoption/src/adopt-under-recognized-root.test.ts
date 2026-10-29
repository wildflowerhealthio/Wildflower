import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { type FhirResource, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type HttpResponse,
  HttpResponseKind,
  type RecognizedUrlData,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { makeHttpResponse } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { Effect, Either, Option, ParseResult, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { originalIdOf } from './adopt-resource.ts'
import { adoptUnderRecognizedRoot } from './adopt-under-recognized-root.ts'

/**
 * Covers the per-kind `adoptUnderRecognizedRoot`: the identity is read verbatim
 * off `tryRecognize` (both a source carrying a `baseUrl` and one without), the
 * two failing arms (an unrecognized URL and a recognized-but-source-less kind),
 * and the referential stability of a single module-level application.
 */

const patient = (id: string | null): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

const ROOT = 'https://ehr.example/baseR4'
const SID = 'https://wildflowerhealth.io/fhir/sid/portal'

/** A `…/Patient` kind whose `tryRecognize` claims with `recognized`, parsing as `parse`. */
const patientKind = (
  name: string,
  recognized: RecognizedUrlData,
  parse: HttpResponseKind.HttpResponseKind<FhirResource>['parse'] = () =>
    Effect.succeed([patient('src-9')])
): HttpResponseKind.HttpResponseKind<FhirResource> =>
  HttpResponseKind.make({
    name,
    tryRecognize: (url) => (url.endsWith('/Patient') ? Option.some(recognized) : Option.none()),
    parse,
  })

/** A kind whose `tryRecognize` mints a source WITH a `baseUrl` (a FHIR root). */
const rootedKind = patientKind('RootedKind', {
  specificity: 50,
  source: { system: ROOT, baseUrl: ROOT },
})

const responseAt = (url: string): HttpResponse.HttpResponse => makeHttpResponse({ url })

const adoptedRooted = adoptUnderRecognizedRoot(rootedKind)

describe('adoptUnderRecognizedRoot', () => {
  test('adopts under the recognized source when it carries a baseUrl', async () => {
    const [resource] = await Effect.runPromise(adoptedRooted.parse(responseAt(`${ROOT}/Patient`)))
    expect(resource?.id).toBe(localResourceId(ROOT, 'Patient', 'src-9'))
    expect(resource === undefined ? null : originalIdOf({ system: ROOT }, resource)).toBe('src-9')
  })

  test('adopts under a source with no baseUrl (a portal sid)', async () => {
    const adopted = adoptUnderRecognizedRoot(
      patientKind('SidKind', { specificity: 100, source: { system: SID } })
    )
    const [resource] = await Effect.runPromise(
      adopted.parse(responseAt('https://portal.example/Patient'))
    )
    expect(resource?.id).toBe(localResourceId(SID, 'Patient', 'src-9'))
  })

  test('adopts a resource the source gave no id under an id of its own', async () => {
    const adopted = adoptUnderRecognizedRoot(
      patientKind('IdLessKind', { specificity: 50, source: { system: ROOT } }, () =>
        Effect.succeed([patient(null)])
      )
    )
    const [resource] = await Effect.runPromise(adopted.parse(responseAt(`${ROOT}/Patient`)))
    expect(resource?.id).toMatch(/^wf-[0-9a-f]{32}$/)
  })

  test('fails with a ParseError when the URL is not recognized', async () => {
    const result = await Effect.runPromise(
      Effect.either(adoptedRooted.parse(responseAt('https://ehr.example/Observation/1')))
    )
    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') throw new Error('expected a Left')
    expect(result.left._tag).toBe('ParseError')
  })

  test('fails with a ParseError when the kind recognizes but mints no source', async () => {
    const adopted = adoptUnderRecognizedRoot(patientKind('NoSourceKind', { specificity: 0 }))
    const result = await Effect.runPromise(
      Effect.either(adopted.parse(responseAt('https://portal.example/Patient')))
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
    const failure = new ParseResult.ParseError({
      issue: new ParseResult.Type(Patient.Schema.ast, 1),
    })
    const adopted = adoptUnderRecognizedRoot(
      patientKind('FailingKind', { specificity: 50, source: { system: ROOT, baseUrl: ROOT } }, () =>
        Effect.fail(failure)
      )
    )
    const result = await Effect.runPromise(
      Effect.either(adopted.parse(responseAt(`${ROOT}/Patient`)))
    )
    expect(result).toEqual(Either.left(failure))
  })

  // Adoption runs inside `Effect.map` only, so a synchronous parse stays
  // synchronously runnable with `Effect.runSync`.
  test('keeps a synchronous parse synchronously runnable', () => {
    expect(Effect.runSync(adoptedRooted.parse(responseAt(`${ROOT}/Patient`)))[0]?.id).toBe(
      localResourceId(ROOT, 'Patient', 'src-9')
    )
  })

  test('is a stable module constant — two reads of its parse are identical', () => {
    // No memo and no source parameter, so one application at module load is the
    // whole story: reading the constant twice yields the same frozen kind.
    expect(adoptedRooted.parse).toBe(adoptedRooted.parse)
    expect(Object.isFrozen(adoptedRooted)).toBe(true)
  })
})
