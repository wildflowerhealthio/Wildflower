import { Client } from '@wildflowerhealthio/authorization-core/domain'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { trustedAppRow } from './trusted-app-row.ts'

describe('trustedAppRow', () => {
  it('should offer Disable for a trusted app and name when it was trusted', () => {
    // Arrange
    const client = decodeClient({ ...ohifViewer, disabledAt: null })

    // Act
    const row = trustedAppRow(client)

    // Assert
    expect(row.action).toBe('disable')
    expect(row.disabled).toBe(false)
    expect(row.subtitle.startsWith('ohif-viewer · Trusted ')).toBe(true)
  })

  it('should offer Enable for a disabled app and name when it was disabled', () => {
    // Arrange
    const client = decodeClient({ ...ohifViewer, disabledAt: '2026-09-01T12:00:00.000Z' })

    // Act
    const row = trustedAppRow(client)

    // Assert
    expect(row.action).toBe('enable')
    expect(row.disabled).toBe(true)
    expect(row.subtitle.startsWith('ohif-viewer · Disabled ')).toBe(true)
  })

  it('should offer no switch for an essential client', () => {
    // Arrange
    const client = decodeClient({
      ...ohifViewer,
      clientId: 'wildflower-host',
      name: 'Wildflower',
      essential: true,
    })

    // Act
    const row = trustedAppRow(client)

    // Assert
    expect(row).toEqual({ action: null, disabled: false, subtitle: 'wildflower-host · Essential' })
  })

  it('should never offer a switch for an essential client, whatever its state', () => {
    fc.assert(
      fc.property(clientArb(), (generated) => {
        // Arrange
        const client = { ...generated, essential: true }

        // Act
        const { action } = trustedAppRow(client)

        // Assert
        expect(action).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always offer Disable exactly when a non-essential app has no disabledAt', () => {
    fc.assert(
      fc.property(clientArb(), (generated) => {
        // Arrange
        const client = { ...generated, essential: false }

        // Act
        const { action, subtitle } = trustedAppRow(client)

        // Assert
        expect(action === 'disable').toBe(client.disabledAt === null)
        expect(action === 'enable').toBe(client.disabledAt !== null)
        expect(subtitle.startsWith(`${client.clientId} · `)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always count an app as disabled exactly when it has a disabledAt', () => {
    fc.assert(
      fc.property(clientArb(), (client) => {
        // Act
        const { disabled } = trustedAppRow(client)

        // Assert
        expect(disabled).toBe(client.disabledAt !== null)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const decodeClient = Schema.decodeUnknownSync(Client.Schema)

/** A migration-seeded SMART app, as `GET /authorization/clients` returns it. */
const ohifViewer = {
  clientId: 'ohif-viewer',
  name: 'OHIF Viewer',
  kind: 'public',
  redirectUris: ['/'],
  allowedScopes: ['openid', 'patient/*.rs'],
  allowedGrantTypes: ['authorization_code', 'refresh_token'],
  registeredAt: '2026-01-15T09:30:00.000Z',
  disabledAt: null,
  essential: false,
}

const instantArb = (): fc.Arbitrary<DateTime.Utc> =>
  fc
    .date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true })
    .map((date) => DateTime.unsafeMake(date))

const clientArb = (): fc.Arbitrary<Client.Type> =>
  fc.record({
    clientId: fc.string(),
    name: fc.string(),
    kind: fc.constantFrom('public' as const, 'confidential' as const),
    redirectUris: fc.array(fc.webUrl()),
    allowedScopes: fc.array(fc.string()),
    allowedGrantTypes: fc.array(fc.string()),
    registeredAt: instantArb(),
    disabledAt: fc.option(instantArb(), { nil: null }),
    essential: fc.boolean(),
  })
