import { Effect, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  fhirServerSourceIdentity,
  fhirServiceBase,
  parseWithFhirServerIdentity,
} from './fhir-server-identity.ts'

/**
 * Covers which server assigned the ids in a response. Getting it wrong is not
 * loud: two responses from one server that disagree on the base derive two
 * namespaces, and the only symptom is an `Observation` whose `subject` names a
 * `Patient` the store does not have. So the base is pinned against the URL
 * shapes collectors actually match, base-path mountings included (`/baseR4`,
 * `/fhir/R4`, Epic's `/interconnect-fhir-oauth/api/FHIR/R4`).
 */

const patient = { resourceType: 'Patient', id: '42', identifier: [] as const }

describe('fhirServiceBase', () => {
  it.each([
    [
      'instance' as const,
      'https://hapi.fhir.org/baseR4/Patient/123',
      'https://hapi.fhir.org/baseR4',
    ],
    [
      'search' as const,
      'https://hapi.fhir.org/baseR4/Observation?_count=250',
      'https://hapi.fhir.org/baseR4',
    ],
    [
      'instance' as const,
      'https://r4.smarthealthit.org/Patient/123',
      'https://r4.smarthealthit.org/',
    ],
    ['search' as const, 'https://hapi.fhir.org/Observation?_count=250', 'https://hapi.fhir.org/'],
    [
      'search' as const,
      'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/Observation?patient=1',
      'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4',
    ],
    [
      'instance' as const,
      'https://example.com:8443/fhir/Patient/1?_format=json',
      'https://example.com:8443/fhir',
    ],
  ])('should reduce a %s URL %s to %s', (shape, url, expected) => {
    // Act / Assert
    expect(fhirServiceBase(new URL(url), shape).href).toBe(expected)
  })

  it('should always agree between a resource URL and its list URL', () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.constantFrom('Patient', 'Observation'),
        // FHIR's id grammar admits `.` and `..`, but those are RFC 3986
        // dot-segments: `new URL()` resolves them away before this function is
        // ever handed a URL, so `…/Patient/..` arrives as the collection URL
        // with the type already gone. Such an id cannot be named by a relative
        // reference at all, so no response URL reaches here carrying one.
        fc.stringMatching(/^[A-Za-z0-9\-.]{1,64}$/).filter((id) => id !== '.' && id !== '..'),
        (root, resourceType, id) => {
          // Arrange — the two URL shapes one server serves to two entities
          const single = new URL(`${root}/${resourceType}/${id}`)
          const list = new URL(`${root}/${resourceType}?_count=250`)

          // Act / Assert — disagreeing here is a dangling `subject` at runtime
          expect(fhirServiceBase(single, 'instance').href).toBe(
            fhirServiceBase(list, 'search').href
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should not mistake a type-shaped id for the resource type', () => {
    // Arrange — a legal instance URL whose id looks exactly like a type
    const url = new URL('https://hapi.fhir.org/baseR4/Patient/JohnDoe')

    // Act / Assert
    expect(fhirServiceBase(url, 'instance').href).toBe('https://hapi.fhir.org/baseR4')
  })

  it('should drop the query and fragment', () => {
    // Act
    const base = fhirServiceBase(
      new URL('https://hapi.fhir.org/baseR4/Patient/1?_format=json#x'),
      'instance'
    )

    // Assert — a namespace that varied with search params would split one server in two
    expect(base.href).toBe('https://hapi.fhir.org/baseR4')
  })
})

describe('fhirServerSourceIdentity', () => {
  it('should name the server and carry the caller-supplied prefix', () => {
    // Act
    const source = fhirServerSourceIdentity(
      'fhir-r4',
      'instance',
      'https://hapi.fhir.org/baseR4/Patient/1'
    )

    // Assert
    expect(source).toEqual(
      Either.right({ prefix: 'fhir-r4', system: new URL('https://hapi.fhir.org/baseR4') })
    )
  })

  it('should report a URL it cannot read rather than throwing', () => {
    // Act / Assert — a response URL reaches a collector from an untyped path
    expect(Either.isLeft(fhirServerSourceIdentity('fhir-r4', 'instance', 'not a url'))).toBe(true)
  })
})

describe('parseWithFhirServerIdentity', () => {
  it('should re-key what a response produced', async () => {
    // Act
    const adopted = await Effect.runPromise(
      parseWithFhirServerIdentity(
        'fhir-r4',
        'instance',
        'https://hapi.fhir.org/baseR4/Patient/42',
        Schema.String.ast,
        [patient]
      )
    )

    // Assert
    expect(adopted[0]?.id).toMatch(/^fhir-r4-[0-9a-f]{32}$/)
  })

  it('should separate two servers that use the same ids', async () => {
    // Act
    const onHapi = await Effect.runPromise(
      parseWithFhirServerIdentity(
        'fhir-r4',
        'instance',
        'https://hapi.fhir.org/baseR4/Patient/42',
        Schema.String.ast,
        [patient]
      )
    )
    const onSmart = await Effect.runPromise(
      parseWithFhirServerIdentity(
        'fhir-r4',
        'instance',
        'https://r4.smarthealthit.org/Patient/42',
        Schema.String.ast,
        [patient]
      )
    )

    // Assert — the collision that motivates the whole derivation
    expect(onSmart[0]?.id).not.toBe(onHapi[0]?.id)
  })

  it('should fail with a ParseError when the response URL cannot be read', async () => {
    // Act
    const outcome = await Effect.runPromise(
      Effect.either(
        parseWithFhirServerIdentity('fhir-r4', 'instance', 'not a url', Schema.String.ast, [
          patient,
        ])
      )
    )

    // Assert — never a defect: one unreadable response must not take a run down
    expect(Either.isLeft(outcome) && outcome.left._tag).toBe('ParseError')
  })
})
