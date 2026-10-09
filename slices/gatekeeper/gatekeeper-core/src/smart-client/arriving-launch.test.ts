import { Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { arrivingSmartLaunchFrom } from './arriving-launch.ts'

describe('arrivingSmartLaunchFrom', () => {
  it('should read an EHR launch from iss and launch', () => {
    // Act / Assert — the launch the desktop base opens a server's launcher with
    expect(
      arrivingSmartLaunchFrom('?iss=https%3A%2F%2Fruth.wildflowerhealth.io%2Ffhir-r4&launch=xyz')
    ).toStrictEqual(Option.some({ iss: 'https://ruth.wildflowerhealth.io/fhir-r4', launch: 'xyz' }))
  })

  it('should read a lone iss as a standalone launch against it', () => {
    // Act / Assert — `appLaunchUrl`'s link for a server with no launcher
    expect(arrivingSmartLaunchFrom('?iss=https%3A%2F%2Ffhir.example%2Fr4')).toStrictEqual(
      Option.some({ iss: 'https://fhir.example/r4', launch: undefined })
    )
  })

  it('should read an empty launch as absent', () => {
    // Act / Assert
    expect(arrivingSmartLaunchFrom('?iss=https%3A%2F%2Ffhir.example%2Fr4&launch=')).toStrictEqual(
      Option.some({ iss: 'https://fhir.example/r4', launch: undefined })
    )
  })

  it.each([
    { case: 'a bare visit', search: '' },
    { case: 'a lone launch', search: '?launch=xyz' },
    { case: 'an empty iss', search: '?iss=&launch=xyz' },
    { case: 'unrelated params', search: '?utm_source=email' },
    {
      case: 'a lone error_description beside an iss',
      search: '?error_description=denied&iss=https%3A%2F%2Ffhir.example%2Fr4',
    },
    {
      case: 'a lone error_uri beside an iss',
      search: '?error_uri=https%3A%2F%2Ffhir.example%2Ferr&iss=https%3A%2F%2Ffhir.example%2Fr4',
    },
  ])('should find no launch in $case', ({ search }) => {
    // Act / Assert
    expect(arrivingSmartLaunchFrom(search)).toStrictEqual(Option.none())
  })

  it('should never read a launch from a return, whatever else it carries', () => {
    fc.assert(
      fc.property(
        fc.subarray(CALLBACK_PARAMS, { minLength: 1 }),
        fc.string(),
        fc.string(),
        nonCallbackParams(),
        (returned, iss, launch, noise) => {
          // Arrange — a callback or an OAuth error, beside an iss and a launch
          const params: Record<string, string> = { ...noise, iss, launch }
          for (const parameter of returned) params[parameter] = 'x'

          // Act / Assert
          expect(arrivingSmartLaunchFrom(searchFrom(params))).toStrictEqual(Option.none())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read every non-empty iss and launch back as they were sent', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        nonCallbackParams(),
        (iss, launch, noise) => {
          // Act / Assert — round-trips through URL encoding untouched
          expect(arrivingSmartLaunchFrom(searchFrom({ ...noise, iss, launch }))).toStrictEqual(
            Option.some({ iss, launch })
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** The params that mark a return from the authorization server, excluded from noise. */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri']

/** A query string built from `params`, leading `?` included. */
const searchFrom = (params: Record<string, string>): string =>
  `?${new URLSearchParams(params).toString()}`

/** Arbitrary query params that are never one of {@link CALLBACK_PARAMS}. */
const nonCallbackParams = (): fc.Arbitrary<Record<string, string>> =>
  fc.dictionary(fc.string(), fc.string()).map((dict) => {
    const copy = { ...dict }
    for (const key of CALLBACK_PARAMS) delete copy[key]
    return copy
  })
