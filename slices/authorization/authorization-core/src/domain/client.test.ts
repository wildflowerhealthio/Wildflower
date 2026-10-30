import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { Client } from './index.ts'

describe('Client.displayName', () => {
  it('names a client by the name it registered under', () => {
    // Arrange
    const clients = [medicationViewer]

    // Act
    const name = Client.displayName(clients, medicationViewer.clientId)

    // Assert
    expect(name).toBe('Medication Viewer')
  })

  it('falls back to the id while the clients load, for an unknown client, and for an unnamed one', () => {
    // Arrange
    const unnamed = { ...medicationViewer, clientId: 'unnamed', name: '' }

    // Act / Assert
    expect(Client.displayName(undefined, medicationViewer.clientId)).toBe(medicationViewer.clientId)
    expect(Client.displayName([medicationViewer], 'someone-else')).toBe('someone-else')
    expect(Client.displayName([unnamed], 'unnamed')).toBe('unnamed')
  })
})

// Helpers

const medicationViewer = Schema.decodeUnknownSync(Client.Schema)({
  clientId: '9769f8b274370708d0d3ebb2e3e59b7c',
  name: 'Medication Viewer',
  kind: 'public',
  redirectUris: ['https://medications.wildflowerhealth.io/'],
  allowedScopes: ['system/MedicationRequest.rs'],
  allowedGrantTypes: ['authorization_code'],
  registeredAt: '2026-01-15T09:30:00.000Z',
  disabledAt: null,
  essential: false,
  refreshPolicy: { idleTtlSeconds: 604800, maxTtlSeconds: 2592000, endsWithBrowserSession: false },
})
