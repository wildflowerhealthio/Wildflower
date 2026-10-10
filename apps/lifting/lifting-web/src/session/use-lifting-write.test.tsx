import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { ACCESS_TOKEN, type FakeFhirServer, SERVER_URL } from '../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  mountLiftingApp,
  startLiftingTest,
} from '../lifting-app.test-helpers.ts'

/**
 * The writes: where they go, and every control waiting on them, driven through
 * `LiftingApp` over the in-memory FHIR server (see
 * `lifting-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(endLiftingTest)

describe('useLiftingWrite', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should address every write to the FHIR server the handshake named, with the granted token', async () => {
    // Arrange
    const user = userEvent.setup()
    mountLiftingApp(server)

    // Act
    await user.click(await screen.findByRole('button', { name: 'Start program' }))
    await screen.findByRole('heading', { name: 'Workout A' })

    // Assert
    expect(server.requests).toEqual([
      { url: `${SERVER_URL}/`, authorization: `Bearer ${ACCESS_TOKEN}` },
    ])
  })
})

describe('useLiftingWriting', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should disable every control while a write is in flight', async () => {
    // Arrange
    const user = userEvent.setup()
    const release = server.holdWrites()
    mountLiftingApp(server)

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
