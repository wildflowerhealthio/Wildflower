import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vite-plus/test'

import { openTab, renderServerPage } from '../-server-page-test-utils.ts'
import golden from '../../../../../../servers-wire-golden.json' with { type: 'json' }
import { setUpEachBaseTest } from '../../../../test-utils/render-base.ts'

setUpEachBaseTest()

describe("the server page's Relay tab", () => {
  it('should send a new token, clear it once accepted, and never show it', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServerPage({
      domain: 'ruth.relay.example.com',
      answers: { server_set_credentials: () => Promise.resolve(null) },
    })
    await openTab('Relay')
    const field = await screen.findByLabelText('New tunnel token')
    expect(field).toHaveProperty('value', '')
    expect(field).toHaveProperty('type', 'password')

    // Act
    await user.type(field, 'tunnel-token-123')
    await user.click(screen.getByRole('button', { name: 'Save token' }))

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_set_credentials',
      args: { domain: 'ruth.relay.example.com', token: 'tunnel-token-123' },
    })
    await waitFor(() => {
      expect(field).toHaveProperty('value', '')
    })
    expect(document.body.textContent).not.toContain('tunnel-token-123')
  })

  it("should show the host's refusal of a new token, without the token", async () => {
    // Arrange
    const user = userEvent.setup()
    const refusal = {
      kind: 'signedRequestRejected',
      message: "the relay didn't accept the tunnel name and token",
    }
    renderServerPage({
      domain: 'ruth.relay.example.com',
      answers: { server_set_credentials: () => Promise.reject(refusal) },
    })
    await openTab('Relay')

    // Act
    await user.type(await screen.findByLabelText('New tunnel token'), 'wrong-token')
    await user.click(screen.getByRole('button', { name: 'Save token' }))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain(refusal.message)
    expect(document.body.textContent).not.toContain('wrong-token')
  })

  it("should warn that the relay's identity changed, with the host's message and no retry", async () => {
    // Arrange
    const user = userEvent.setup()
    const refusal = golden.enrolmentErrors.relayIdentityChanged
    renderServerPage({
      domain: 'ruth.relay.example.com',
      answers: { server_set_credentials: () => Promise.reject(refusal) },
    })
    await openTab('Relay')

    // Act
    await user.type(await screen.findByLabelText('New tunnel token'), 'tunnel-token-123')
    await user.click(screen.getByRole('button', { name: 'Save token' }))

    // Assert
    const warning = await screen.findByRole('alert')
    expect(within(warning).getByText("The relay's identity has changed")).toBeDefined()
    expect(within(warning).getByText(/remove this server and add it again/)).toBeDefined()
    expect(within(warning).getByText(refusal.message)).toBeDefined()
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    expect(document.body.textContent).not.toContain('tunnel-token-123')
  })
})
