import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { ACCESS_TOKEN, type FakeFhirServer, SERVER_URL } from '../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endStrengthTest,
  mountStrengthApp,
  startStrengthTest,
} from '../strength-app.test-helpers.ts'

/**
 * The writes: where they go, and every control waiting on them, driven through
 * `StrengthApp` over the in-memory FHIR server (see
 * `strength-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startStrengthTest()
})

afterEach(endStrengthTest)

describe('useStrengthWrite', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should address every write to the FHIR server the handshake named, with the granted token', async () => {
    // Arrange
    const user = userEvent.setup()
    mountStrengthApp(server)

    // Act
    await user.click(await screen.findByRole('button', { name: 'Start program' }))
    await screen.findByRole('heading', { name: 'Workout A' })

    // Assert
    expect(server.requests).toEqual([
      { url: `${SERVER_URL}/`, authorization: `Bearer ${ACCESS_TOKEN}` },
    ])
  })
})

describe('useStrengthWriting', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should disable every control while a write is in flight', async () => {
    // Arrange
    const user = userEvent.setup()
    const release = server.holdWrites()
    mountStrengthApp(server)

    // Act
    await user.click(await screen.findByRole('button', { name: 'Start program' }))

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Starting…' }).closest('fieldset')?.disabled).toBe(
        true
      )
    })
    release()
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
  })
})
