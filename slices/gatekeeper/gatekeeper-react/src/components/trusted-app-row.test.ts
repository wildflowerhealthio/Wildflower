import { DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Client } from '../queries/index.ts'
import { trustedAppRow } from './trusted-app-row.ts'

describe('trustedAppRow', () => {
  it('should offer Disable for a trusted app and name when it was trusted', () => {
    // Arrange
    const client = decodeClient({ ...ohifViewer, disabledAt: null })

    // Act
    const row = trustedAppRow(client, now)

    // Assert
    expect(row.action).toBe('disable')
    expect(row.disabled).toBe(false)
    expect(row.subtitle.startsWith('ohif-viewer · Trusted ')).toBe(true)
  })

  it('should offer Enable for a disabled app and name when it was disabled', () => {
    // Arrange
    const client = decodeClient({ ...ohifViewer, disabledAt: '2026-09-01T12:00:00.000Z' })

    // Act
    const row = trustedAppRow(client, now)

    // Assert
    expect(row.action).toBe('enable')
    expect(row.disabled).toBe(true)
    expect(row.subtitle.startsWith('ohif-viewer · Disabled ')).toBe(true)
  })

  it('should show a scheduled disable as not yet disabled, with Enable to cancel it', () => {
    // Arrange
    const client = decodeClient({ ...ohifViewer, disabledAt: '2026-10-01T12:00:00.000Z' })

    // Act
    const row = trustedAppRow(client, now)

    // Assert
    expect(row.action).toBe('enable')
    expect(row.disabled).toBe(false)
    expect(row.subtitle.startsWith('ohif-viewer · Disables ')).toBe(true)
  })

  it('should offer no switch for the first-party host', () => {
    // Arrange
    const client = decodeClient({
      ...ohifViewer,
      clientId: 'wildflower-host',
      name: 'Wildflower',
      firstParty: true,
    })

    // Act
    const row = trustedAppRow(client, now)

    // Assert
    expect(row).toEqual({ action: null, disabled: false, subtitle: 'wildflower-host · Built in' })
  })

  it('should never offer a switch for the first-party host, whatever its state', () => {
    fc.assert(
      fc.property(clientArb(), instantArb(), (generated, at) => {
        // Arrange
        const client = { ...generated, firstParty: true }

        // Act
        const { action } = trustedAppRow(client, at)

        // Assert
        expect(action).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always offer Disable exactly when a non-host app has no disabledAt', () => {
    fc.assert(
      fc.property(clientArb(), instantArb(), (generated, at) => {
        // Arrange
        const client = { ...generated, firstParty: false }

        // Act
        const { action, subtitle } = trustedAppRow(client, at)

        // Assert
        expect(action === 'disable').toBe(client.disabledAt === null)
        expect(action === 'enable').toBe(client.disabledAt !== null)
        expect(subtitle.startsWith(`${client.clientId} · `)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should count an app as disabled exactly once its disabledAt has arrived', () => {
    fc.assert(
      fc.property(clientArb(), instantArb(), (client, at) => {
        // Act
        const { disabled } = trustedAppRow(client, at)

        // Assert
        const arrived =
          client.disabledAt !== null &&
          DateTime.toEpochMillis(client.disabledAt) <= DateTime.toEpochMillis(at)
        expect(disabled).toBe(arrived)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const decodeClient = Schema.decodeUnknownSync(AccessManagement.ClientSchema)

/** The instant the example rows are derived at: after the fixed disable, before the scheduled one. */
const now = DateTime.unsafeMake('2026-09-15T00:00:00.000Z')

/** A migration-seeded SMART app, as `GET /access/clients` returns it. */
const ohifViewer = {
  clientId: 'ohif-viewer',
  name: 'OHIF Viewer',
  kind: 'public',
  redirectUris: ['/'],
  allowedScopes: ['openid', 'patient/*.rs'],
  allowedGrantTypes: ['authorization_code', 'refresh_token'],
  registeredAt: '2026-01-15T09:30:00.000Z',
  disabledAt: null,
  firstParty: false,
}

const instantArb = (): fc.Arbitrary<DateTime.Utc> =>
  fc
    .date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true })
    .map((date) => DateTime.unsafeMake(date))

const clientArb = (): fc.Arbitrary<Client> =>
  fc.record({
    clientId: fc.string(),
    name: fc.string(),
    kind: fc.constantFrom('public' as const, 'confidential' as const),
    redirectUris: fc.array(fc.webUrl()),
    allowedScopes: fc.array(fc.string()),
    allowedGrantTypes: fc.array(fc.string()),
    registeredAt: instantArb(),
    disabledAt: fc.option(instantArb(), { nil: null }),
    firstParty: fc.boolean(),
  })
