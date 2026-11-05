import { arrivingSmartLaunchFrom as sharedArrivingSmartLaunchFrom } from '@wildflowerhealthio/authorization-core/smart-client'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { encodeLaunchError, LAUNCH_ERROR_PARAM } from './launch-error.ts'
import { arrivingSmartLaunchFrom, RootArrival, rootArrivalFrom } from './root-arrival.ts'

/** A query string built from `params`, leading `?` included. */
const searchFrom = (params: Record<string, string>): string =>
  `?${new URLSearchParams(params).toString()}`

/**
 * Arbitrary query params that carry no arrival of their own: never an
 * authorization-response parameter, an `iss`, or our `launchError`.
 */
const unrelatedParams = (): fc.Arbitrary<Record<string, string>> =>
  fc.dictionary(fc.string(), fc.string()).map((dict) => {
    const copy = { ...dict }
    for (const key of [
      'code',
      'state',
      'error',
      'error_description',
      'error_uri',
      'iss',
      LAUNCH_ERROR_PARAM,
    ]) {
      delete copy[key]
    }
    return copy
  })

describe('rootArrivalFrom', () => {
  it('reads a code and its state as a sign-in return', () => {
    expect(rootArrivalFrom('?code=abc&state=xyz')).toEqual(
      RootArrival.SignInReturn({ code: 'abc', state: 'xyz' })
    )
  })

  it('reads a code with no state as a sign-in return its redemption will refuse', () => {
    expect(rootArrivalFrom('?code=abc')).toEqual(
      RootArrival.SignInReturn({ code: 'abc', state: '' })
    )
  })

  it('reads a state alone as a self-addressed sign-in return', () => {
    expect(rootArrivalFrom('?state=xyz')).toEqual(
      RootArrival.SelfAddressedSignInReturn({ state: 'xyz' })
    )
  })

  it('reads the authorization server’s error return as a refusal, despite its state', () => {
    expect(
      rootArrivalFrom('?error=access_denied&error_description=No+thanks&state=xyz&code=abc')
    ).toEqual(
      RootArrival.SignInRefused({
        refusal: {
          error: 'AuthorizationDenied',
          message: 'access_denied',
          description: 'No thanks',
          uri: undefined,
        },
      })
    )
  })

  it('reads an iss as a launch request', () => {
    expect(rootArrivalFrom('?iss=https%3A%2F%2Fehr.example%2Ffhir&launch=xyz')).toEqual(
      RootArrival.LaunchRequest({ launch: { iss: 'https://ehr.example/fhir', launch: 'xyz' } })
    )
  })

  it('reads a bare visit as a visit with no launch failure', () => {
    expect(rootArrivalFrom('')).toEqual(RootArrival.Visit({ launchError: Option.none() }))
  })

  it('reads our own launch error as a visit carrying it', () => {
    const body = { error: 'HandshakeFailed', message: 'token exchange rejected' }
    expect(rootArrivalFrom(`?${LAUNCH_ERROR_PARAM}=${encodeLaunchError(body)}`)).toEqual(
      RootArrival.Visit({ launchError: Option.some(body) })
    )
  })

  it('reads a launch error that does not decode as one with no tag', () => {
    expect(rootArrivalFrom(`?${LAUNCH_ERROR_PARAM}=%%%not-base64%%%`)).toEqual(
      RootArrival.Visit({ launchError: Option.some({ error: '' }) })
    )
  })

  it('property: a code, with or without unrelated params, is always a sign-in return', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string(),
        unrelatedParams(),
        (code, state, noise) => {
          expect(rootArrivalFrom(searchFrom({ ...noise, code, state }))).toEqual(
            RootArrival.SignInReturn({ code, state })
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: an error param is always a refusal, whatever comes with it', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.dictionary(fc.string(), fc.string()),
        (error, others) => {
          expect(rootArrivalFrom(searchFrom({ ...others, error }))._tag).toBe('SignInRefused')
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: a query with no arrival of its own is a plain visit', () => {
    fc.assert(
      fc.property(unrelatedParams(), (noise) => {
        expect(rootArrivalFrom(searchFrom(noise))).toEqual(
          RootArrival.Visit({ launchError: Option.none() })
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// `arrivingSmartLaunchFrom`'s own behaviour is covered where it lives, in
// `authorization-core/smart-client`'s `arriving-launch.test.ts`; re-exporting is
// only worth anything if it is genuinely the same function.
describe('arrivingSmartLaunchFrom', () => {
  it('is the one implementation authorization-core owns, not a local copy', () => {
    expect(arrivingSmartLaunchFrom).toBe(sharedArrivingSmartLaunchFrom)
  })
})
