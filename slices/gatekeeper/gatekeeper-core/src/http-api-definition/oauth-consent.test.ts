import { Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  ApproveOAuthConsentBody,
  OAuthConsentRegistrationSchema,
  OAuthConsentSchema,
  RegistrationNotAcknowledgedSchema,
} from './oauth-consent.ts'

/**
 * `OAuthConsentSchema.registration` is the trust-on-first-use wire contract's
 * consumer-facing half: it round-trips the server's `registered` / `new` /
 * `changed` union, and `ApproveOAuthConsentBody.acknowledgedRegistration`
 * carries the Owner's checkbox back. These are pure schema round-trip tests —
 * decode/encode symmetry, not business logic (that lives server-side).
 */

describe('OAuthConsentRegistrationSchema', () => {
  it('decodes the registered variant with no extra fields', () => {
    // Arrange
    const wire = { status: 'registered' }

    // Act
    const decoded = Schema.decodeUnknownSync(OAuthConsentRegistrationSchema)(wire)

    // Assert
    expect(decoded).toEqual({ status: 'registered' })
  })

  it('decodes the new variant with no extra fields', () => {
    // Arrange
    const wire = { status: 'new' }

    // Act
    const decoded = Schema.decodeUnknownSync(OAuthConsentRegistrationSchema)(wire)

    // Assert
    expect(decoded).toEqual({ status: 'new' })
  })

  it('decodes the changed variant carrying redirectUriIsNew and newScopes', () => {
    // Arrange
    const wire = { status: 'changed', redirectUriIsNew: true, newScopes: ['patient/Observation.r'] }

    // Act
    const decoded = Schema.decodeUnknownSync(OAuthConsentRegistrationSchema)(wire)

    // Assert
    expect(decoded).toEqual({
      status: 'changed',
      redirectUriIsNew: true,
      newScopes: ['patient/Observation.r'],
    })
  })

  it('rejects an unrecognized status literal', () => {
    // Arrange
    const wire = { status: 'unknown-status' }

    // Act / Assert
    expect(() => Schema.decodeUnknownSync(OAuthConsentRegistrationSchema)(wire)).toThrow()
  })

  it('round-trips any changed newScopes list through encode/decode', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(fc.string()), (redirectUriIsNew, newScopes) => {
        // Arrange
        const value = { status: 'changed' as const, redirectUriIsNew, newScopes }

        // Act
        const wire = Schema.encodeSync(OAuthConsentRegistrationSchema)(value)
        const decoded = Schema.decodeUnknownSync(OAuthConsentRegistrationSchema)(wire)

        // Assert
        expect(decoded).toEqual(value)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('OAuthConsentSchema', () => {
  it('requires a registration field', () => {
    // Arrange — a wire body identical to the pre-registration contract.
    const wire = {
      id: 'consent-1',
      clientId: 'app.example',
      clientName: 'App Example',
      scopes: ['patient/Observation.r'],
      redirectUri: 'https://app.example/cb',
      preApprovedScopes: [],
      patient: null,
    }

    // Act / Assert — decoding without `registration` fails now that it's required.
    expect(() => Schema.decodeUnknownSync(OAuthConsentSchema)(wire)).toThrow()
  })

  it('decodes a full consent body carrying a changed registration', () => {
    // Arrange
    const wire = {
      id: 'consent-1',
      clientId: 'app.example',
      clientName: 'App Example',
      scopes: ['patient/Observation.r'],
      redirectUri: 'https://app.example/cb',
      preApprovedScopes: [],
      patient: null,
      registration: { status: 'changed', redirectUriIsNew: false, newScopes: [] },
    }

    // Act
    const decoded = Schema.decodeUnknownSync(OAuthConsentSchema)(wire)

    // Assert
    expect(decoded.registration).toEqual({
      status: 'changed',
      redirectUriIsNew: false,
      newScopes: [],
    })
  })
})

describe('ApproveOAuthConsentBody', () => {
  it('requires acknowledgedRegistration', () => {
    // Arrange
    const wire = { approvedScopes: ['patient/Observation.r'], patient: null }

    // Act / Assert
    expect(() => Schema.decodeUnknownSync(ApproveOAuthConsentBody)(wire)).toThrow()
  })

  it('decodes with acknowledgedRegistration set', () => {
    // Arrange
    const wire = {
      approvedScopes: ['patient/Observation.r'],
      patient: null,
      acknowledgedRegistration: true,
    }

    // Act
    const decoded = Schema.decodeUnknownSync(ApproveOAuthConsentBody)(wire)

    // Assert
    expect(decoded.acknowledgedRegistration).toBe(true)
  })
})

describe('RegistrationNotAcknowledgedSchema', () => {
  it('decodes the tagged error shape', () => {
    // Arrange
    const wire = { error: 'RegistrationNotAcknowledged', id: 'consent-1' }

    // Act
    const decoded = Schema.decodeUnknownSync(RegistrationNotAcknowledgedSchema)(wire)

    // Assert
    expect(decoded).toEqual({ error: 'RegistrationNotAcknowledged', id: 'consent-1' })
  })
})
