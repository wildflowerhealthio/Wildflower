import { act, screen, waitFor, within } from '@testing-library/react'
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
import {
  type FakeEvents,
  type FakeHost,
  fakeEvents,
  hostWith,
} from '../../../../test-utils/host-fakes.ts'
import {
  DEFAULT_AUTHORIZATION_URL,
  openDialog,
  openDialogOrThrow,
  renderBase,
  storageAnswered,
  setUpEachBaseTest,
} from '../../../../test-utils/render-base.ts'

setUpEachBaseTest()

/** `instant`, an RFC 3339 string, as the page shows its dates. */
const shownInstant = (instant: string): string => formatInstant(DateTime.unsafeMake(instant))

describe("the server page's Certificate tab", () => {
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

describe("the Certificate tab's certificate order", () => {
  const DOMAIN = 'ruth.relay.example.com'
  const UNREACHABLE = "This server can't be reached until its certificate arrives."

  /** The Certificate tab of a host listing ruth with `status`, whose duplicate-certificate limit is `limit`. */
  const renderCertificateTab = ({
    status,
    limit = null,
    answers = {},
    events = fakeEvents(),
  }: {
    readonly status: { readonly certificate: unknown }
    readonly limit?: unknown
    readonly answers?: Readonly<Record<string, () => Promise<unknown>>>
    readonly events?: FakeEvents
  }): FakeHost =>
    renderServerPage({
      domain: DOMAIN,
      tab: 'certificate',
      events,
      servers: listedWithRuthStatus(status),
      answers: {
        server_duplicate_certificate_limit: () => Promise.resolve(limit),
        ...answers,
      },
    })

  /** Press the button named `name`, once it can be pressed, and answer the dialog it opens. */
  const pressOrder = async (name: string): Promise<HTMLDialogElement> => {
    const button = await screen.findByRole('button', { name })
    await waitFor(() => {
      expect(button).toHaveProperty('disabled', false)
    })
    await userEvent.click(button)
    return openDialogOrThrow()
  }

  it("should offer Order certificate, under the warning that it can't be reached, to a running server ordering with none held", async () => {
    // Arrange
    const host = renderCertificateTab({
      status: golden.serverStatuses.runningCacheFailed,
      answers: { server_order_certificate: () => Promise.resolve(null) },
    })

    // Act
    const dialog = await pressOrder('Order certificate')

    // Assert
    expect(within(dialog).getByRole('heading', { name: 'Order a certificate now?' })).toBeDefined()
    expect(dialog.textContent).toContain(
      'The server orders one now, without waiting for its next try.'
    )

    // Act
    await userEvent.click(within(dialog).getByRole('button', { name: 'Order' }))

    // Assert
    const warning = screen.getByText(UNREACHABLE)
    const button = screen.getByRole('button', { name: 'Order certificate' })
    expect(warning.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Replace certificate' })).toBeNull()
    await waitFor(() => {
      expect(openDialog()).toBeNull()
    })
    expect(host.seen).toContainEqual({
      command: 'server_order_certificate',
      args: { domain: DOMAIN },
    })
  })

  it('should order the kind its confirm asked for, even once a certificate has arrived meanwhile', async () => {
    // Arrange
    const events = fakeEvents()
    const host = renderCertificateTab({
      status: golden.serverStatuses.runningCacheFailed,
      events,
      answers: { server_order_certificate: () => Promise.resolve(null) },
    })
    const dialog = await pressOrder('Order certificate')
    act(() => {
      events.emit('server-status', golden.serverStatuses.runningAndReachable)
    })
    await screen.findByRole('button', { name: 'Replace certificate' })

    // Act
    await userEvent.click(within(dialog).getByRole('button', { name: 'Order' }))

    // Assert
    await waitFor(() => {
      expect(host.seen).toContainEqual({
        command: 'server_order_certificate',
        args: { domain: DOMAIN },
      })
    })
    expect(host.seen.map(({ command }) => command)).not.toContain('server_force_new_certificate')
  })

  it("should offer Replace certificate to a running server holding one, its confirm saying it can't be reached meanwhile", async () => {
    // Arrange
    const host = renderCertificateTab({
      status: golden.serverStatuses.runningAndReachable,
      limit: golden.duplicateCertificateLimit.oneBelowTheLimit,
      answers: { server_force_new_certificate: () => Promise.resolve(null) },
    })

    // Act
    const dialog = await pressOrder('Replace certificate')

    // Assert
    expect(screen.queryByRole('button', { name: 'Order certificate' })).toBeNull()
    expect(screen.queryByText(UNREACHABLE)).toBeNull()
    expect(within(dialog).getByRole('heading', { name: 'Replace the certificate?' })).toBeDefined()
    expect(dialog.textContent).toContain(
      "It can't be reached until the new one arrives, usually within a minute or two."
    )
    expect(dialog.textContent).not.toContain("Let's Encrypt")

    // Act
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace' }))

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_force_new_certificate',
      args: { domain: DOMAIN },
    })
  })

  it.each(['neverRun', 'startingUnchecked', 'stoppedWithAnError'] as const)(
    'should offer no order to a server that is %s',
    async (statusName) => {
      // Act
      const host = renderCertificateTab({ status: golden.serverStatuses[statusName] })

      // Assert
      expect(await screen.findByRole('heading', { name: 'Certificate' })).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Order certificate' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Replace certificate' })).toBeNull()
      expect(screen.queryByText(UNREACHABLE)).toBeNull()
      expect(host.seen.map(({ command }) => command)).not.toContain(
        'server_duplicate_certificate_limit'
      )
    }
  )

  it("should disable the order once Let's Encrypt's limit is used up, saying when it issues another", async () => {
    // Arrange
    const { oldestLeavesWindowAt } = golden.duplicateCertificateLimit.atTheLimit

    // Act
    renderCertificateTab({
      status: golden.serverStatuses.runningAndReachable,
      limit: golden.duplicateCertificateLimit.atTheLimit,
    })

    // Assert
    const note = await screen.findByText(
      `Let's Encrypt has issued all 5 certificates it allows this domain in 7 days. It can issue another after ${shownInstant(oldestLeavesWindowAt)}.`
    )
    const button = screen.getByRole('button', { name: 'Replace certificate' })
    expect(button).toHaveProperty('disabled', true)
    expect(note.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("should show the host's limitUsedUp refusal above the button", async () => {
    // Arrange
    const refusal = golden.certificateOrderRequestErrors.find(({ kind }) => kind === 'limitUsedUp')
    if (refusal === undefined) throw new Error('no limitUsedUp refusal in the golden file')
    renderCertificateTab({
      status: golden.serverStatuses.runningAndReachable,
      answers: { server_force_new_certificate: () => Promise.reject(refusal) },
    })

    // Act
    const dialog = await pressOrder('Replace certificate')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace' }))

    // Assert
    const shown = await screen.findByText(refusal.message)
    const button = screen.getByRole('button', { name: 'Replace certificate' })
    expect(shown.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await waitFor(() => {
      expect(openDialog()).toBeNull()
    })
  })
})
