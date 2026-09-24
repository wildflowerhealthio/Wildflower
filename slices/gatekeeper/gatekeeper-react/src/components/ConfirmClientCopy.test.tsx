import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { CLIENT_BASE_URL_PARAM } from 'gatekeeper-core/smart-client'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ConfirmClientCopy } from './ConfirmClientCopy.tsx'

const PREVIEW_BASE = 'https://wildflowerhealthio.github.io/staging/pr-736/app/'

afterEach(() => {
  cleanup()
})

describe('ConfirmClientCopy', () => {
  it('should show the page when no copy is named', () => {
    // Act
    renderDevicesPage('?server=http%3A%2F%2F127.0.0.1')

    // Assert
    expect(screen.getByText('Enter Code')).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Continue there' })).toBeNull()
  })

  it('should offer the same page on the named copy before showing this one', () => {
    // Act
    renderDevicesPage(`?server=http%3A%2F%2F127.0.0.1&${confirmParam(PREVIEW_BASE)}`)

    // Assert
    expect(screen.queryByText('Enter Code')).toBeNull()
    expect(screen.getByRole('link', { name: 'Continue there' }).getAttribute('href')).toBe(
      `${PREVIEW_BASE}gatekeeper/devices?server=http%3A%2F%2F127.0.0.1`
    )
  })

  it('should show the page once the Owner stays here', async () => {
    // Arrange
    renderDevicesPage(`?${confirmParam(PREVIEW_BASE)}`)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Stay here' }))

    // Assert
    expect(screen.getByText('Enter Code')).toBeDefined()
  })

  it.each(['javascript:alert(1)', 'data:text/html,hi', '/staging/app/'])(
    'should never offer %j as a link',
    (named) => {
      // Act
      renderDevicesPage(`?${confirmParam(named)}`)

      // Assert
      expect(screen.queryByRole('link', { name: 'Continue there' })).toBeNull()
      expect(screen.getByText('Enter Code')).toBeDefined()
    }
  )
})

// Helpers

/** A stand-in for the device-entry page, confirming on `search`. */
const renderDevicesPage = (search: string): void => {
  render(
    <ConfirmClientCopy route="/gatekeeper/devices" search={search}>
      <h1>Enter Code</h1>
    </ConfirmClientCopy>
  )
}

const confirmParam = (clientBase: string): string =>
  `${CLIENT_BASE_URL_PARAM}=${encodeURIComponent(clientBase)}`
