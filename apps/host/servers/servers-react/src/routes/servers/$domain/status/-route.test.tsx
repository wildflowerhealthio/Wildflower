import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateTime } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  healthCheck,
  heroBadge,
  listedWithRuthStatus,
  passingReport,
  renderServerPage,
  sectionTitled,
} from '../-server-page-test-utils.ts'
import golden from '../../../../../../servers-wire-golden.json' with { type: 'json' }
import { formatInstant } from '../../../../server-status-text.ts'
import { fakeEvents, fakeHealth } from '../../../../test-utils/host-fakes.ts'
import { setUpEachBaseTest } from '../../../../test-utils/render-base.ts'

setUpEachBaseTest()

describe("the server page's Status tab", () => {
  it.each([
    ['runningAndReachable', 'Connected.', false],
    ['runningCacheFailed', 'Connecting.', false],
    ['runningUnreachable', 'Connected.', false],
    ['runningReconnecting', 'Reconnecting: the relay closed the connection', false],
    [
      'runningTokenRejected',
      'The relay rejected the tunnel token. Enter a new one on the Relay tab.',
      true,
    ],
    ['runningTunnelUnknown', 'The relay has no tunnel named ruth. It may have been deleted.', true],
  ] as const)(
    'should show the relay connection of a %s status as "%s", as a failure only when it is one',
    async (statusName, text, failure) => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses[statusName]),
      })

      // Assert
      expect(await screen.findByRole('heading', { name: 'Connection' })).toBeDefined()
      const row = within(sectionTitled('Connection')).getByText('Relay connection').closest('li')
      expect(row?.textContent).toContain(text)
      expect(/tone-danger/.test(row?.className ?? '')).toBe(failure)
    }
  )

  it.each([
    ['runningAndReachable', 'Reachable: its /health answers pass.'],
    ['runningRenewalFailed', 'Checking it can be reached.'],
    ['runningCacheFailed', 'Not checked until the relay connection is up.'],
    [
      'runningReconnecting',
      'Reachable before its relay connection changed: its /health answered pass.',
    ],
    [
      'runningTokenRejected',
      'Reachable before its relay connection changed: its /health answered pass.',
    ],
    [
      'runningTunnelUnknown',
      'Reachable before its relay connection changed: its /health answered pass.',
    ],
  ] as const)(
    'should show the connection of a %s status as "%s", by its tunnel when that is not connected',
    async (statusName, text) => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses[statusName]),
      })

      // Assert
      expect(await screen.findByRole('heading', { name: 'Connection' })).toBeDefined()
      expect(within(sectionTitled('Connection')).getByText(text)).toBeDefined()
    }
  )

  it.each(['runningRenewalFailed', 'stoppedWithAnError'] as const)(
    'should show no relay connection for a %s status, which reports no tunnel',
    async (statusName) => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        servers: listedWithRuthStatus(golden.serverStatuses[statusName]),
      })

      // Assert
      expect(await screen.findByRole('heading', { name: 'Connection' })).toBeDefined()
      expect(within(sectionTitled('Connection')).queryByText('Relay connection')).toBeNull()
    }
  )

  it("should list each check of a passing /health, read from the server's public origin", async () => {
    // Arrange
    const health = fakeHealth(() => Response.json(passingReport))

    // Act
    renderServerPage({ domain: 'ruth.relay.example.com', health })

    // Assert
    expect(await screen.findByText('Its /health answers pass.')).toBeDefined()
    const checks = sectionTitled('Health checks')
    for (const title of ['Server', 'Connectivity', 'Fhir R4']) {
      expect(within(checks).getByText(title)).toBeDefined()
    }
    expect(health.urls).toEqual(['https://ruth.relay.example.com/health'])
  })

  it('should list the checks of a failing /health from its 503', async () => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      health: fakeHealth(() =>
        Response.json(
          {
            status: 'fail',
            checks: { server: [healthCheck('pass')], connectivity: [healthCheck('fail')] },
          },
          { status: 503 }
        )
      ),
    })

    // Assert
    expect(await screen.findByText('Its /health answers fail.')).toBeDefined()
    const connectivity = within(sectionTitled('Health checks')).getByText('Connectivity')
    expect(connectivity.closest('li')?.textContent).toContain('fail')
  })

  it.each([
    ['a 404', () => new Response('not found', { status: 404 }), /^Couldn't read it: .*404/],
    [
      'a network error',
      () => {
        throw new TypeError('Failed to fetch')
      },
      /^Couldn't read it: Transport error/,
    ],
  ] as const)('should say why /health could not be read after %s', async (_, answer, shown) => {
    // Act
    renderServerPage({ domain: 'ruth.relay.example.com', health: fakeHealth(answer) })

    // Assert
    expect(await screen.findByText(shown)).toBeDefined()
  })

  it('should read /health again on Refresh', async () => {
    // Arrange
    const user = userEvent.setup()
    const health = fakeHealth(() => Response.json(passingReport))
    renderServerPage({ domain: 'ruth.relay.example.com', health })
    await screen.findByText('Its /health answers pass.')

    // Act
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    // Assert
    await waitFor(() => {
      expect(health.urls).toHaveLength(2)
    })
  })

  it('should read no /health while the server is stopped', async () => {
    // Arrange
    const health = fakeHealth(() => Response.json(passingReport))

    // Act
    renderServerPage({ domain: 'lab.rathole.example.com', health })

    // Assert
    expect(
      await screen.findByText("It stopped with an error: the server's config couldn't be built")
    ).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Health checks' })).toBeNull()
    expect(health.urls).toEqual([])
  })

  it('should read /health again for a new run, and stay current with server-status events', async () => {
    // Arrange
    const events = fakeEvents()
    const health = fakeHealth(() => Response.json(passingReport))
    renderServerPage({ domain: 'ruth.relay.example.com', health, events })
    await screen.findByText('Its /health answers pass.')

    // Act
    events.emit('server-status', golden.serverStatuses.stoppedByThePlatform)

    // Assert
    expect(await screen.findByText('The system ended its time in the background.')).toBeDefined()
    expect(screen.getByText("The system's time limit for background work ran out.")).toBeDefined()
    expect((await heroBadge()).textContent).toMatch(/Stopped$/)
    expect(screen.queryByRole('heading', { name: 'Health checks' })).toBeNull()

    // Act
    events.emit('server-status', {
      ...golden.serverStatuses.runningAndReachable,
      runningSince: '2026-10-06T18:00:00Z',
    })

    // Assert
    expect(await screen.findByText('Its /health answers pass.')).toBeDefined()
    expect(health.urls).toHaveLength(2)
    expect((await heroBadge()).textContent).toMatch(/Running$/)
  })

  it.each([
    ['neverRun', "It hasn't run yet."],
    ['startingUnchecked', 'Starting.'],
    ['startingCaUnreachable', 'Starting.'],
    ['runningUnreachable', 'Not reachable yet: the relay answered 502'],
  ] as const)('should show the connection of a %s status as "%s"', async (statusName, text) => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      servers: listedWithRuthStatus(golden.serverStatuses[statusName]),
    })

    // Assert
    expect(await screen.findByRole('heading', { name: 'Connection' })).toBeDefined()
    expect(within(sectionTitled('Connection')).getByText(text)).toBeDefined()
  })

  it.each([
    ['stoppedWithAnError', false],
    ['stoppedByThePlatform', true],
    ['stoppedAsItsPolicyEnded', false],
  ] as const)(
    "should say when a %s server stopped, with the platform's reason only when it gave one",
    async (statusName, hasPlatformReason) => {
      // Arrange
      const status = golden.serverStatuses[statusName]

      // Act
      renderServerPage({ domain: 'ruth.relay.example.com', servers: listedWithRuthStatus(status) })

      // Assert
      expect(await screen.findByRole('heading', { name: 'Connection' })).toBeDefined()
      const connection = within(sectionTitled('Connection'))
      expect(connection.getByText('Stopped').closest('li')?.textContent).toContain(
        formatInstant(DateTime.unsafeMake(status.lastStop.stoppedAt))
      )
      expect(connection.queryByText('Platform reason') !== null).toBe(hasPlatformReason)
    }
  )

  it('should show no stop for a server that has never run', async () => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      servers: listedWithRuthStatus(golden.serverStatuses.neverRun),
    })

    // Assert
    expect(await screen.findByText("It hasn't run yet.")).toBeDefined()
    const connection = within(sectionTitled('Connection'))
    expect(connection.queryByText('Stopped')).toBeNull()
    expect(connection.queryByText('Platform reason')).toBeNull()
  })

  it('should mark a failing /health, and only its failing checks, as failures', async () => {
    // Act
    renderServerPage({
      domain: 'ruth.relay.example.com',
      health: fakeHealth(() =>
        Response.json(
          {
            status: 'fail',
            checks: { server: [healthCheck('pass')], connectivity: [healthCheck('fail')] },
          },
          { status: 503 }
        )
      ),
    })

    // Assert
    const report = (await screen.findByText('Its /health answers fail.')).closest('li')
    expect(report?.className).toMatch(/tone-danger/)
    const checks = within(sectionTitled('Health checks'))
    expect(checks.getByText('Connectivity').closest('li')?.className).toMatch(/tone-danger/)
    expect(checks.getByText('Server').closest('li')?.className).not.toMatch(/tone-danger/)
  })

  it('should not mark a passing /health as a failure', async () => {
    // Act
    renderServerPage({ domain: 'ruth.relay.example.com' })

    // Assert
    const report = (await screen.findByText('Its /health answers pass.')).closest('li')
    expect(report?.className).not.toMatch(/tone-danger/)
  })
})
