import { Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  FALLBACK_LAUNCH_MESSAGE,
  LAUNCH_ERROR_MESSAGES,
  LAUNCH_ERROR_PARAM,
  decodeLaunchError,
  encodeLaunchError,
  launchError,
  launchErrorBodyFor,
  launchErrorFrom,
  launchErrorRedirect,
  type LaunchErrorBody,
} from './launch-error.ts'

/** Arbitrary free text, including the non-Latin-1 that a naive `btoa` breaks on. */
const text = fc.string({ minLength: 1, maxLength: 60 })

/** A launch-error body with every field independently present or absent. */
const bodyArb: fc.Arbitrary<LaunchErrorBody> = fc.record(
  {
    error: fc.string({ minLength: 1, maxLength: 24 }),
    message: text,
    iss: fc.webUrl(),
    description: text,
    uri: fc.webUrl(),
    missingScopes: fc.array(fc.stringMatching(/^[a-z/.*]{1,20}$/), { maxLength: 4 }),
  },
  { requiredKeys: ['error'] }
)

describe('encodeLaunchError / decodeLaunchError', () => {
  it('round-trips any body through the URL-safe base64 wire', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        expect(decodeLaunchError(encodeLaunchError(body))).toEqual(Option.some(body))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('encodes to characters that survive a URL untouched', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const encoded = encodeLaunchError(body)
        // URL-safe base64: no `+`, `/` or `=`, and encodeURIComponent is a no-op.
        expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/)
        expect(encodeURIComponent(encoded)).toBe(encoded)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('survives a round trip through an actual URL', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const href = launchErrorRedirect('https://wildflowerhealth.io/medications-app/', body)
        const parameter = new URL(href).searchParams.get(LAUNCH_ERROR_PARAM)
        expect(parameter).not.toBeNull()
        expect(decodeLaunchError(parameter ?? '')).toEqual(Option.some(body))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('returns None for a parameter that is not valid base64 JSON', () => {
    // A hand-edited or truncated URL must not throw its way out of the banner.
    expect(decodeLaunchError('not-base64-json')).toEqual(Option.none())
    expect(decodeLaunchError('!!!!')).toEqual(Option.none())
    expect(decodeLaunchError('')).toEqual(Option.none())
  })

  it('returns None for base64 JSON that is not a launch-error body', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant({}), fc.record({ error: fc.integer() })),
        (value) => {
          const parameter = btoa(JSON.stringify(value)).replace(/=+$/, '')
          expect(decodeLaunchError(parameter)).toEqual(Option.none())
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('reads an empty text field as absent', () => {
    const decoded = decodeLaunchError(
      encodeLaunchError({ error: 'AuthorizeFailed', message: '', iss: '' })
    )
    expect(decoded).toEqual(Option.some({ error: 'AuthorizeFailed' }))
  })
})

describe('launchErrorRedirect', () => {
  it('never carries an OAuth callback parameter to the target', () => {
    // This is the anti-loop property: `shouldCompleteSmartLaunch` reads
    // `code`/`state`, so carrying either would send the app root back into the
    // launched branch and fail the same single-use code forever.
    fc.assert(
      fc.property(bodyArb, text, text, (body, code, state) => {
        const source = new URL('https://wildflowerhealth.io/medications-app/')
        source.searchParams.set('code', code)
        source.searchParams.set('state', state)
        source.searchParams.set('error', 'access_denied')
        source.searchParams.set('error_description', 'nope')
        source.searchParams.set('error_uri', 'https://example.test/why')

        const target = new URL(launchErrorRedirect(source.href, body))
        for (const parameter of ['code', 'state', 'error', 'error_description', 'error_uri']) {
          expect(target.searchParams.has(parameter)).toBe(false)
        }
        // And the resulting URL is one the reader finds no callback in.
        expect(launchErrorFrom(target.search)).not.toBeNull()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('keeps parameters the target already carried', () => {
    const href = launchErrorRedirect('https://wildflowerhealth.io/web-trace/?keep=me', {
      error: 'AuthorizeFailed',
    })
    expect(new URL(href).searchParams.get('keep')).toBe('me')
  })

  it('preserves the target path and origin', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const root = 'https://ruth.wildflowerhealth.io/importer-app/'
        const target = new URL(launchErrorRedirect(root, body))
        expect(target.origin).toBe('https://ruth.wildflowerhealth.io')
        expect(target.pathname).toBe('/importer-app/')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('launchErrorFrom', () => {
  it('returns null for a search with no failure in it', () => {
    // The resting state: the banner renders nothing for a plain visit or a
    // successful callback.
    expect(launchErrorFrom('')).toBeNull()
    expect(launchErrorFrom('?code=abc&state=xyz')).toBeNull()
    expect(launchErrorFrom(`?${LAUNCH_ERROR_PARAM}=`)).toBeNull()
  })

  it('reports any encoded body as an Error carrying its detail', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const search = `?${LAUNCH_ERROR_PARAM}=${encodeLaunchError(body)}`
        const reported = launchErrorFrom(search)
        expect(reported).toBeInstanceOf(Error)
        // The detail the body carried is never dropped on the floor — it is the
        // whole point of the transport.
        const detail = body.description ?? body.message
        if (detail !== undefined && detail !== '') {
          expect(reported?.message).toContain(detail)
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reads the OAuth error return the app root would otherwise ignore', () => {
    const reported = launchErrorFrom(
      '?error=access_denied&error_description=The+user+declined&state=xyz'
    )
    expect(reported).toBeInstanceOf(Error)
    expect(reported?.message).toContain(LAUNCH_ERROR_MESSAGES['AuthorizationDenied'] ?? '')
    expect(reported?.message).toContain('The user declined')
  })

  it('attaches the diagnostics as own fields, where the details block reads them', () => {
    const search = `?${LAUNCH_ERROR_PARAM}=${encodeLaunchError({
      error: 'AuthorizeFailed',
      message: 'Failed to fetch',
      iss: 'https://ruth.wildflowerhealth.io/fhir-r4',
    })}`
    const reported = launchErrorFrom(search)
    expect(reported).not.toBeNull()
    expect(Reflect.get(reported ?? {}, 'tag')).toBe('AuthorizeFailed')
    expect(Reflect.get(reported ?? {}, 'iss')).toBe('https://ruth.wildflowerhealth.io/fhir-r4')
  })

  it('prefers our own body over an OAuth error when both are present', () => {
    const search = `?error=access_denied&${LAUNCH_ERROR_PARAM}=${encodeLaunchError({
      error: 'HandshakeFailed',
      message: 'token exchange rejected',
    })}`
    expect(launchErrorFrom(search)?.message).toContain('token exchange rejected')
  })

  it('falls back to a readable message for an undecodable parameter', () => {
    // Garbage in the URL still produces a sentence, never `[object Object]`
    // and never a throw.
    const reported = launchErrorFrom(`?${LAUNCH_ERROR_PARAM}=%%%not-base64%%%`)
    expect(reported?.message).toBe(FALLBACK_LAUNCH_MESSAGE)
  })

  it('never produces an empty or object-stringified message', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const message = launchErrorFrom(
          `?${LAUNCH_ERROR_PARAM}=${encodeLaunchError(body)}`
        )?.message
        expect(message).toBeDefined()
        expect(message).not.toBe('')
        expect(message).not.toContain('[object Object]')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('launchError', () => {
  it('opens with the tag’s sentence when the tag is a known one', () => {
    for (const [tag, sentence] of Object.entries(LAUNCH_ERROR_MESSAGES)) {
      expect(launchError(Option.some({ error: tag })).message).toBe(sentence)
    }
  })

  it('falls back for an unknown or missing tag', () => {
    expect(launchError(Option.some({ error: 'SomethingNew' })).message).toBe(
      FALLBACK_LAUNCH_MESSAGE
    )
    expect(launchError(Option.some({ error: '' })).message).toBe(FALLBACK_LAUNCH_MESSAGE)
    expect(launchError(Option.none()).message).toBe(FALLBACK_LAUNCH_MESSAGE)
  })
})

describe('launchErrorBodyFor', () => {
  it('carries the thrown message and the iss the launch URL named', () => {
    const body = launchErrorBodyFor(
      'AuthorizeFailed',
      new TypeError('Failed to fetch'),
      '?launch=abc&iss=https://ruth.wildflowerhealth.io/fhir-r4'
    )
    expect(body).toEqual({
      error: 'AuthorizeFailed',
      message: 'Failed to fetch',
      iss: 'https://ruth.wildflowerhealth.io/fhir-r4',
    })
  })

  it('stringifies a non-Error throw rather than losing it', () => {
    fc.assert(
      fc.property(fc.oneof(text, fc.integer(), fc.boolean()), (thrown) => {
        const body = launchErrorBodyFor('AuthorizeFailed', thrown, '')
        expect(body.message).toBe(String(thrown))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('omits iss when the launch URL named none', () => {
    const body = launchErrorBodyFor('HandshakeFailed', new Error('nope'), '?code=abc')
    expect(body.iss).toBeUndefined()
    expect('iss' in body).toBe(false)
  })

  it('round-trips end to end, from the throw to the rendered message', () => {
    // The whole contract in one line: a launch page catching `error` produces a
    // URL whose app root reports that same message to the user.
    fc.assert(
      fc.property(text, fc.webUrl(), (message, iss) => {
        const body = launchErrorBodyFor(
          'AuthorizeFailed',
          new Error(message),
          `?iss=${encodeURIComponent(iss)}`
        )
        const href = launchErrorRedirect('https://wildflowerhealth.io/medications-app/', body)
        const reported = launchErrorFrom(new URL(href).search)
        expect(reported?.message).toContain(message)
        expect(Reflect.get(reported ?? {}, 'iss')).toBe(iss)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
