import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vite-plus/test'

import {
  listedWithRuthStatus,
  openTab,
  openTabName,
  renderServerPage,
  sectionTitled,
} from '../-server-page-test-utils.ts'
import golden from '../../../../../../servers-wire-golden.json' with { type: 'json' }
import { fakeEvents, hostWith } from '../../../../test-utils/host-fakes.ts'
import {
  renderBase,
  storageAnswered,
  setUpEachBaseTest,
} from '../../../../test-utils/render-base.ts'

setUpEachBaseTest()

describe("the server page's Access tab", () => {
  const RUTH = 'ruth.relay.example.com'
  const LAB = 'lab.rathole.example.com'

  describe('a pending request', () => {
    it('should list the client waiting on the server, and open it', async () => {
      // Arrange
      const user = userEvent.setup()
      const host = renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses.runningWithAPendingConsent),
        answers: { server_open_pending_consent: () => Promise.resolve(null) },
      })
      await screen.findByRole('heading', { name: 'Access' })
      const access = sectionTitled('Access')

      // Act
      await user.click(within(access).getByRole('button', { name: 'Open' }))

      // Assert
      expect(access.textContent).toContain('Pending request')
      expect(access.textContent).toContain('Lifting wants access.')
      expect(host.seen.filter(({ command }) => command === 'server_open_pending_consent')).toEqual([
        { command: 'server_open_pending_consent', args: { domain: 'ruth.relay.example.com' } },
      ])
    })

    it("should say why the host didn't open it, in place of who waits", async () => {
      // Arrange
      const user = userEvent.setup()
      const nothingPending = golden.launchErrors[8]
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses.runningWithAPendingConsent),
        answers: { server_open_pending_consent: () => Promise.reject(nothingPending) },
      })
      await screen.findByRole('heading', { name: 'Access' })

      // Act
      await user.click(within(sectionTitled('Access')).getByRole('button', { name: 'Open' }))

      // Assert
      await waitFor(() => {
        expect(sectionTitled('Access').textContent).toContain(nothingPending.message)
      })
      expect(sectionTitled('Access').textContent).not.toContain('Lifting wants access.')
    })

    it('should say none waits for a server with nothing waiting', async () => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        tab: 'access',
        servers: listedWithRuthStatus(golden.serverStatuses.runningAndReachable),
      })

      // Assert
      expect(await screen.findByText('No requests waiting.')).toBeDefined()
      expect(screen.getByRole('button', { name: 'Open Authorization app' })).toBeDefined()
    })

    it("should show once the server's status carries a request, without leaving the open tab", async () => {
      // Arrange
      const events = fakeEvents()
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses.runningAndReachable),
        events,
      })
      expect(await openTabName()).toBe('Status')

      // Act
      act(() => {
        events.emit('server-status', golden.serverStatuses.runningWithAPendingConsent)
      })

      // Assert
      expect(await openTabName()).toBe('Status')

      // Act
      await openTab('Access')

      // Assert
      expect(await screen.findByRole('heading', { name: 'Access' })).toBeDefined()
      expect(screen.queryByText('No requests waiting.')).toBeNull()
    })

    it('should drop the failure to open a request once another waits in its place', async () => {
      // Arrange
      const user = userEvent.setup()
      const events = fakeEvents()
      const nothingPending = golden.launchErrors[8]
      renderServerPage({
        domain: RUTH,
        servers: listedWithRuthStatus(golden.serverStatuses.runningWithAPendingConsent),
        answers: { server_open_pending_consent: () => Promise.reject(nothingPending) },
        events,
      })
      await screen.findByRole('heading', { name: 'Access' })
      await user.click(within(sectionTitled('Access')).getByRole('button', { name: 'Open' }))
      await waitFor(() => {
        expect(sectionTitled('Access').textContent).toContain(nothingPending.message)
      })

      // Act
      act(() => {
        events.emit('server-status', {
          ...golden.serverStatuses.runningWithAPendingConsent,
          pendingConsent: { ...golden.pendingConsents[0], clientName: 'Plots' },
        })
      })

      // Assert
      expect(await within(sectionTitled('Access')).findByText('Plots wants access.')).toBeDefined()
      expect(sectionTitled('Access').textContent).not.toContain(nothingPending.message)
    })
  })

  it("should open the Authorization app from the server page's Access tab, and show its refusal in its row", async () => {
    // Arrange
    const user = userEvent.setup()
    const host = hostWith({
      servers: () => Promise.resolve(golden.listedServers),
      answers: { server_open_authorization_app: () => Promise.reject(golden.launchErrors[2]) },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: `/servers/${RUTH}/access`,
    })
    const open = await screen.findByRole('button', { name: 'Open Authorization app' })
    const row = open.closest('li')
    expect(row?.textContent).toContain('Lists the apps and devices with access to this server.')

    // Act
    await user.click(open)

    // Assert
    expect(host.seen.filter(({ command }) => command === 'server_open_authorization_app')).toEqual([
      { command: 'server_open_authorization_app', args: { domain: RUTH } },
    ])
    await waitFor(() => {
      expect(row?.textContent).toContain(golden.launchErrors[2].message)
    })
  })

  it("should be disabled on the server page's Access tab for a server the host would refuse", async () => {
    // Arrange
    renderBase({
      invoke: hostWith({ servers: () => Promise.resolve(golden.listedServers) }).invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: `/servers/${LAB}/access`,
    })

    // Assert
    expect(await screen.findByRole('button', { name: 'Open Authorization app' })).toHaveProperty(
      'disabled',
      true
    )
  })
})
