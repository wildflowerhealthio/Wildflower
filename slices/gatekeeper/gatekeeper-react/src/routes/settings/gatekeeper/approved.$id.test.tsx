import { cleanup, render, screen } from '@testing-library/react'
import { Schema } from 'effect'
import { AccessManagement } from 'gatekeeper-core/http-api-definition'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { GrantDetailBody } from './approved.$id.tsx'

/**
 * `approved.$id.tsx` calls `createFileRoute('/settings/gatekeeper/approved/$id')`
 * at import time, and its `PageHeader` back-link renders a TanStack `<Link>`;
 * stub both so the presentational `GrantDetailBody` renders without a
 * `RouterProvider`. `Link` becomes a plain anchor.
 */
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createFileRoute:
      () =>
      (config: unknown): unknown =>
        config,
    Link: ({ to, children }: { to?: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  }
})

const decodeGrant = Schema.decodeUnknownSync(AccessManagement.GrantSchema)

const appGrant = decodeGrant({
  id: 'g-app',
  clientId: 'client-a',
  scopes: ['read', 'write'],
  grantType: 'authorization_code',
  redirectUri: 'https://example.com/cb',
  grantedAt: '2024-01-01T00:00:00.000Z',
  lastUsedAt: null,
  patient: null,
})

const deviceGrant = decodeGrant({
  id: 'g-dev',
  clientId: 'client-b',
  scopes: ['openid'],
  grantType: 'device_code',
  deviceName: "Ada's laptop",
  grantedAt: '2024-02-02T00:00:00.000Z',
  lastUsedAt: null,
  patient: null,
})

afterEach(() => {
  cleanup()
})

/**
 * The shared detail route renders per-variant off `grantType`: a code grant
 * shows its redirect URI under an "Approved App" heading, a device grant shows
 * its device name under an "Authorized Device" heading. Each variant's
 * discriminating field is absent from the other.
 */
describe('GrantDetailBody', () => {
  test('renders the authorization-code variant with its redirect URI', () => {
    render(<GrantDetailBody grant={appGrant} />)

    expect(screen.getByText('Approved App')).toBeTruthy()
    expect(screen.getByText('Redirect URI:')).toBeTruthy()
    // The device-only field must not render for a code grant.
    expect(screen.queryByText('Device:')).toBeNull()
  })

  test('renders the device-code variant with its device name', () => {
    render(<GrantDetailBody grant={deviceGrant} />)

    expect(screen.getByText('Authorized Device')).toBeTruthy()
    expect(screen.getByText('Device:')).toBeTruthy()
    expect(screen.getByText("Ada's laptop")).toBeTruthy()
    // The code-only field must not render for a device grant.
    expect(screen.queryByText('Redirect URI:')).toBeNull()
  })
})
