import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateTime } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  listedWithRuthStatus,
  openTab,
  renderServerPage,
  sectionTitled,
} from '../-server-page-test-utils.ts'
import golden from '../../../../../../servers-wire-golden.json' with { type: 'json' }
import { formatInstant } from '../../../../server-status-text.ts'
import { fakeEvents, hostWith } from '../../../../test-utils/host-fakes.ts'
import {
  DEFAULT_AUTHORIZATION_URL,
  renderBase,
  storageAnswered,
  setUpEachBaseTest,
} from '../../../../test-utils/render-base.ts'

setUpEachBaseTest()

describe("the server page's Certificate tab", () => {
  /** `instant`, an RFC 3339 string, as the page shows its dates. */
  const shownInstant = (instant: string): string => formatInstant(DateTime.unsafeMake(instant))

  /** The row of the Certificate section titled `title`. */
  const certificateRow = (title: string): HTMLElement => {
    const row = within(sectionTitled('Certificate')).getByText(title).closest('li')
    if (row === null) throw new Error(`no ${title} row`)
    return row
  }

  it.each([
    ['neverRun', 'None yet. The server orders one when it runs.', false],
    ['runningCacheFailed', 'Ordering one from the certificate authority.', false],
    ['runningAndReachable', 'Valid.', false],
    [
      'runningRenewalFailed',
      'Valid, and due for renewal, which the server makes while it runs.',
      false,
    ],
    ['stoppedWithAnError', 'Expired. The server renews it when it starts.', false],
    ['startingCaUnreachable', 'No valid certificate: ordering one is failing.', true],
    ['stoppedByThePlatform', "The certificate stored on this device couldn't be read.", true],
  ] as const)(
    'should show the certificate of a %s status as "%s", as a failure only when it is one',
    async (statusName, text, failure) => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses[statusName]),
      })
      await openTab('Certificate')

      // Assert
      expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
      const status = certificateRow('Status')
      expect(status.textContent).toContain(text)
      expect(/tone-danger/.test(status.className)).toBe(failure)
    }
  )

  it("should show the server's certificate authority, the held certificate's validity and fingerprint, and no error when there is none", async () => {
    // Arrange
    const { held } = golden.listedServers[0].certificate

    // Act
    renderServerPage({ domain: 'ruth.relay.example.com' })
    await openTab('Certificate')

    // Assert
    expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
    expect(certificateRow('Certificate authority').textContent).toMatch(/Let's Encrypt$/)
    expect(within(sectionTitled('Certificate')).queryByText('State shown for')).toBeNull()
    expect(certificateRow('Valid from').textContent).toContain(shownInstant(held.notBefore))
    expect(certificateRow('Valid until').textContent).toContain(shownInstant(held.notAfter))
    expect(certificateRow('SHA-256 fingerprint').textContent).toContain(held.fingerprint)
    expect(within(sectionTitled('Certificate')).queryByText('Last error')).toBeNull()
  })

  it("should show the server's certificate authority, and the one the state is for when it differs", async () => {
    // Arrange
    const host = hostWith({
      servers: () =>
        Promise.resolve(listedWithRuthStatus(golden.serverStatuses.runningRenewalFailed)),
      answers: { server_update: () => Promise.resolve(null) },
    })
    const user = userEvent.setup()
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: '/servers/ruth.relay.example.com/default-apps',
    })

    // Act
    await user.clear(await screen.findByLabelText('App launcher'))
    await user.type(screen.getByLabelText('App launcher'), 'https://launcher.example.com/')
    await user.click(screen.getByRole('button', { name: 'Save App Launcher URL' }))
    await openTab('Certificate')

    // Assert
    expect(certificateRow('Certificate authority').textContent).toMatch(/Let's Encrypt$/)
    expect(certificateRow('State shown for').textContent).toMatch(
      /Let's Encrypt staging, which browsers don't trust$/
    )
    expect(host.seen).toContainEqual({
      command: 'server_update',
      args: {
        domain: 'ruth.relay.example.com',
        launcherUrl: 'https://launcher.example.com/',
        authorizationUrl: DEFAULT_AUTHORIZATION_URL,
        certificateAuthority: 'letsEncrypt',
      },
    })
  })

  it('should show the issuer, and no validity or fingerprint, while no certificate is held', async () => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      servers: listedWithRuthStatus(golden.serverStatuses.neverRun),
    })
    await openTab('Certificate')

    // Assert
    expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
    expect(certificateRow('Certificate authority').textContent).toMatch(/Let's Encrypt$/)
    const certificate = within(sectionTitled('Certificate'))
    expect(certificate.queryByText('Valid from')).toBeNull()
    expect(certificate.queryByText('Valid until')).toBeNull()
    expect(certificate.queryByText('SHA-256 fingerprint')).toBeNull()
  })

  /** `golden.serverStatuses.startingCaUnreachable` with its certificate's `lastError` set to `lastError`. */
  const withLastError = (lastError: unknown): { readonly certificate: unknown } => ({
    ...golden.serverStatuses.startingCaUnreachable,
    certificate: { ...golden.serverStatuses.startingCaUnreachable.certificate, lastError },
  })

  it.each([
    [
      'a rate limit with no retry time',
      withLastError({ kind: 'rateLimited' }),
      "The certificate authority's rate limit was reached.",
    ],
    [
      'a failed challenge, with its detail',
      golden.serverStatuses.runningRenewalFailed,
      "The certificate authority couldn't validate this server's domain: Connection refused",
    ],
    [
      'a failed challenge with no detail',
      withLastError({ kind: 'challengeFailed' }),
      "The certificate authority couldn't validate this server's domain.",
    ],
    [
      'an unreachable CA',
      golden.serverStatuses.startingCaUnreachable,
      "The certificate authority couldn't be reached: http request error: io error: Connection refused",
    ],
    [
      'another order failure',
      withLastError({ kind: 'other', message: 'the order was invalid' }),
      'Ordering failed: the order was invalid',
    ],
    [
      'a cache fault',
      golden.serverStatuses.runningCacheFailed,
      "The certificates on this device couldn't be read or written: account cache store: disk full",
    ],
  ] as const)('should describe %s as the last error', async (_, status, text) => {
    // Act
    renderServerPage({ domain: 'ruth.relay.example.com', servers: listedWithRuthStatus(status) })
    await openTab('Certificate')

    // Assert
    expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
    const lastError = certificateRow('Last error')
    expect(lastError.textContent).toContain(text)
    expect(lastError.className).toMatch(/tone-danger/)
  })

  it('should say when the CA said to retry a rate limit, and that it has passed once it has', async () => {
    // Arrange
    const { retryAfter } = golden.serverStatuses.runningUnreachable.certificate.lastError
    const said = `The certificate authority's rate limit was reached; it said to retry after ${shownInstant(retryAfter)}`
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.parse(retryAfter) - 60_000 })
    try {
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses.runningUnreachable),
      })
      await openTab('Certificate')
      expect(await screen.findByText(`${said}.`)).toBeDefined()

      // Act
      act(() => {
        vi.advanceTimersByTime(60_000)
      })

      // Assert
      expect(await screen.findByText(`${said}; that time has passed.`)).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('should show the certificate state of each server-status event', async () => {
    // Arrange
    const events = fakeEvents()
    renderServerPage({ domain: 'ruth.relay.example.com', events })
    await openTab('Certificate')
    await screen.findByRole('heading', { name: 'Certificate' })

    // Act
    events.emit('server-status', golden.serverStatuses.stoppedByThePlatform)

    // Assert
    expect(
      await screen.findByText("The certificate stored on this device couldn't be read.")
    ).toBeDefined()
    expect(certificateRow('Last error').textContent).toContain(
      'reading the certificate cache failed: Permission denied (os error 13)'
    )
    expect(within(sectionTitled('Certificate')).queryByText('SHA-256 fingerprint')).toBeNull()
  })
})
