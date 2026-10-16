import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vite-plus/test'

import { passingReport, renderServerPage } from '../-server-page-test-utils.ts'
import golden from '../../../../../../servers-wire-golden.json' with { type: 'json' }
import { fakeHealth, hostWith } from '../../../../test-utils/host-fakes.ts'
import {
  openDialog,
  renderBase,
  storageAnswered,
  setUpEachBaseTest,
} from '../../../../test-utils/render-base.ts'

setUpEachBaseTest()

describe("the server page's Destructive actions tab", () => {
  /** The open confirm dialog. */
  const confirmDialog = (): HTMLDialogElement => {
    const dialog = openDialog()
    if (dialog === null) throw new Error('no confirm dialog')
    return dialog
  }

  it('should remove the server only once its domain is typed and confirmed, then return to the list', async () => {
    // Arrange
    const user = userEvent.setup()
    let listed: readonly unknown[] = golden.listedServers
    const host = hostWith({
      servers: () => Promise.resolve(listed),
      answers: {
        server_remove: () => {
          listed = [golden.listedServers[0]]
          return Promise.resolve(null)
        },
      },
    })
    renderBase({
      invoke: host.invoke,
      storage: storageAnswered({ crashReports: false, performance: false }),
      path: '/servers/lab.rathole.example.com/destructive-actions',
      httpClient: fakeHealth(() => Response.json(passingReport)).layer,
    })
    const remove = await screen.findByRole('button', { name: 'Remove' })

    // Act
    await user.click(remove)
    await user.click(within(confirmDialog()).getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(host.seen.map(({ command }) => command)).not.toContain('server_remove')

    // Act
    await user.click(remove)
    const confirm = within(confirmDialog()).getByRole('button', { name: 'Remove' })

    // Assert
    expect(confirm).toHaveProperty('disabled', true)

    // Act
    await user.type(
      within(confirmDialog()).getByLabelText('Type lab.rathole.example.com to confirm'),
      'lab.rathole.example.com'
    )
    await user.click(confirm)

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_remove',
      args: { domain: 'lab.rathole.example.com' },
    })
    expect(await screen.findByRole('listitem', { name: 'ruth.relay.example.com' })).toBeDefined()
    expect(screen.queryByRole('listitem', { name: 'lab.rathole.example.com' })).toBeNull()
  })

  it("should show the host's refusal, and stay on the page, when the host can't remove the server", async () => {
    // Arrange
    const user = userEvent.setup()
    renderServerPage({
      domain: 'lab.rathole.example.com',
      tab: 'destructive-actions',
      answers: { server_remove: () => Promise.reject(golden.commandErrors[2]) },
    })
    await user.click(await screen.findByRole('button', { name: 'Remove' }))
    await user.type(
      within(confirmDialog()).getByLabelText('Type lab.rathole.example.com to confirm'),
      'lab.rathole.example.com'
    )

    // Act
    await user.click(within(confirmDialog()).getByRole('button', { name: 'Remove' }))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain(
      golden.commandErrors[2].message
    )
    expect(screen.getByRole('heading', { name: 'Server' })).toBeDefined()
  })
})
