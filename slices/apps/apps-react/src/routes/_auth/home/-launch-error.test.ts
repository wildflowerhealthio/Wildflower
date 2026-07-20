import { describe, expect, test } from 'vite-plus/test'

import { encodeLaunchError, launchBannerError, launchErrorTag } from './-launch-error.ts'

describe('launch-error encoding', () => {
  test('an InsufficientScope body round-trips so the banner can name the scopes', () => {
    const body = { error: 'InsufficientScope', missingScopes: ['wildflower/Grant.d'] } as const

    // The decoded body is returned verbatim (the app's ambient renderer turns it
    // into the AuthorizationFailure surface), not flattened to a message.
    expect(launchBannerError(encodeLaunchError(body))).toEqual(body)
  })

  test('a non-scope tag reads as a friendly message', () => {
    expect(launchBannerError(encodeLaunchError({ error: 'AppNotFound' }))).toBe(
      'That app is no longer available.'
    )
    expect(launchBannerError(encodeLaunchError({ error: 'LaunchUnavailable' }))).toContain(
      'reached'
    )
  })

  test('an unknown tag falls back to the generic launch message', () => {
    expect(launchBannerError(encodeLaunchError({ error: 'Whatever' }))).toBe(
      'That app couldn’t be launched.'
    )
  })

  test('no param → null; a malformed param → the generic message', () => {
    expect(launchBannerError(undefined)).toBeNull()
    expect(launchBannerError('')).toBeNull()
    expect(launchBannerError('not-valid-base64-json!!')).toBe('That app couldn’t be launched.')
  })

  test('launchErrorTag reads a string error tag, else undefined', () => {
    expect(launchErrorTag({ error: 'AppNotFound' })).toBe('AppNotFound')
    expect(launchErrorTag({ error: 42 })).toBeUndefined()
    expect(launchErrorTag(null)).toBeUndefined()
    expect(launchErrorTag('nope')).toBeUndefined()
  })
})
