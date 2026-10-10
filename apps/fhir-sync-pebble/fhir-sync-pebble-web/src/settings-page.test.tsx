import { cleanup, render, screen } from '@testing-library/react'
import { Either } from 'effect'
import { PebbleSettings } from 'fhir-sync-pebble-core'
import { ReturnTarget, type ReturnTargetStore } from 'pebble-configuration'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SettingsPage } from './settings-page.tsx'

// The confirmation branch searches the server's patients through route context,
// so it is driven end to end in `app.test.tsx`; this file covers the page's
// refusals, which mount no router.

afterEach(() => {
  cleanup()
})

describe('SettingsPage', () => {
  it('should explain, and offer no save, when the server granted no access token', () => {
    // Act
    render(
      <SettingsPage
        connection={Either.left(new PebbleSettings.MissingGrantError())}
        returnTargets={storeRecalling(ReturnTarget.DEFAULT)}
        navigate={ignoreNavigation}
      />
    )

    // Assert
    expect(screen.getByText(/did not grant an access token/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save to watch' })).toBeNull()
  })

  it('should refuse to send the connection anywhere but the Pebble app', () => {
    // Act
    render(
      <SettingsPage
        connection={Either.right(connection)}
        returnTargets={storeRecalling('https://collector.example/#')}
        navigate={ignoreNavigation}
      />
    )

    // Assert
    expect(screen.getByText(/not the Pebble app/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save to watch' })).toBeNull()
  })
})

// Helpers

const connection: PebbleSettings.Connection = {
  accessToken: 'watch-token',
  fhirBaseUrl: 'https://fhir.example/r4',
}

const ignoreNavigation = (): void => undefined

/** A store whose kept `return_to` is `returnTo`. */
const storeRecalling = (returnTo: string): ReturnTargetStore.Store => ({
  rememberFrom: (): void => undefined,
  recall: () => ReturnTarget.decode(returnTo),
})
