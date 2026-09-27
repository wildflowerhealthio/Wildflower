import { cleanup, render, screen } from '@testing-library/react'
import { Either } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import * as PebbleSettings from './pebble-settings.ts'
import type * as ReturnTargetStore from './return-target-store.ts'
import * as ReturnTarget from './return-target.ts'
import { SettingsPage } from './settings-page.tsx'

// The confirmation branch reads the patient through route context, so it is
// driven end to end in `app.test.tsx`; this file covers the page's refusals,
// which mount no router.

afterEach(() => {
  cleanup()
})

describe('SettingsPage', () => {
  it('should explain, and offer no save, when the server put no patient in context', () => {
    // Act
    render(
      <SettingsPage
        connection={Either.left(new PebbleSettings.MissingGrantError())}
        returnTargets={storeRecalling(ReturnTarget.DEFAULT)}
        navigate={ignoreNavigation}
      />
    )

    // Assert
    expect(screen.getByText(/did not grant a patient/)).toBeDefined()
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

  it('should start over at the app root to choose a different patient', () => {
    // Arrange
    window.history.replaceState(null, '', '/fhir-sync-pebble/?code=abc&state=xyz')

    // Act
    render(
      <SettingsPage
        connection={Either.left(new PebbleSettings.MissingGrantError())}
        returnTargets={storeRecalling(ReturnTarget.DEFAULT)}
        navigate={ignoreNavigation}
      />
    )

    // Assert
    expect(
      screen.getByRole('link', { name: 'Choose a different patient' }).getAttribute('href')
    ).toBe(`${window.location.origin}/fhir-sync-pebble/`)
  })
})

// Helpers

const connection: PebbleSettings.Connection = {
  patientId: 'ada',
  accessToken: 'watch-token',
  fhirBaseUrl: 'https://fhir.example/r4',
}

const ignoreNavigation = (): void => undefined

/** A store whose kept `return_to` is `returnTo`. */
const storeRecalling = (returnTo: string): ReturnTargetStore.Store => ({
  rememberFrom: (): void => undefined,
  recall: () => ReturnTarget.decode(returnTo),
})
