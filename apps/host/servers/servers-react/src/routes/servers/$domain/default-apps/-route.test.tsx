import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vite-plus/test'

import { renderServerPage } from '../-server-page-test-utils.ts'
import golden from '../../../../../../servers-wire-golden.json' with { type: 'json' }
import {
  DEFAULT_AUTHORIZATION_URL,
  DEFAULT_LAUNCHER_URL,
  setUpEachBaseTest,
} from '../../../../test-utils/render-base.ts'

setUpEachBaseTest()

describe("the server page's Default Apps tab", () => {
  /** The form of the server page's field labelled `label`. */
  const formOf = async (label: string): Promise<HTMLElement> => {
    const form = (await screen.findByLabelText(label)).closest('form')
    if (form === null) throw new Error(`no form for ${label}`)
    return form
  }

  it('should save an edited launcher with the Authorization app and certificate authority unchanged', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServerPage({
      domain: 'lab.rathole.example.com',
      tab: 'default-apps',
      answers: { server_update: () => Promise.resolve(null) },
    })
    const field = await screen.findByLabelText('App launcher')
    const save = screen.getByRole('button', { name: 'Save App Launcher URL' })
    expect(save).toHaveProperty('disabled', true)

    // Act
    await user.clear(field)
    await user.type(field, 'https://launcher.example.com/app')
    await user.click(save)

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_update',
      args: {
        domain: 'lab.rathole.example.com',
        launcherUrl: 'https://launcher.example.com/app',
        authorizationUrl: 'http://localhost:5300/authorization/',
        certificateAuthority: 'letsEncryptStaging',
      },
    })
    await waitFor(() => {
      expect(save).toHaveProperty('disabled', true)
    })
  })

  it('should save an edited Authorization app with the launcher and certificate authority unchanged', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServerPage({
      domain: 'lab.rathole.example.com',
      tab: 'default-apps',
      answers: { server_update: () => Promise.resolve(null) },
    })
    const field = await screen.findByLabelText('Authorization')
    const save = screen.getByRole('button', { name: 'Save Authorization Manager URL' })
    expect(field).toHaveProperty('value', 'http://localhost:5300/authorization/')
    expect(save).toHaveProperty('disabled', true)

    // Act
    await user.clear(field)
    await user.type(field, 'https://authorization.example.com/')
    await user.click(save)

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_update',
      args: {
        domain: 'lab.rathole.example.com',
        launcherUrl: 'http://localhost:5200/app',
        authorizationUrl: 'https://authorization.example.com/',
        certificateAuthority: 'letsEncryptStaging',
      },
    })
    await waitFor(() => {
      expect(save).toHaveProperty('disabled', true)
    })
  })

  it("should show the host's refusal of an Authorization app under its field", async () => {
    // Arrange
    const user = userEvent.setup()
    const refusal = {
      kind: 'invalidAuthorizationUrl',
      message:
        'the entered Authorization URL "ftp://authorization.example.com/" is not an http or https URL',
    }
    renderServerPage({
      domain: 'lab.rathole.example.com',
      tab: 'default-apps',
      answers: { server_update: () => Promise.reject(refusal) },
    })
    const field = await screen.findByLabelText('Authorization')

    // Act
    await user.clear(field)
    await user.type(field, 'ftp://authorization.example.com/')
    await user.click(screen.getByRole('button', { name: 'Save Authorization Manager URL' }))

    // Assert
    const form = await formOf('Authorization')
    expect(await within(form).findByText(refusal.message, { exact: false })).toBeDefined()
    expect(within(await formOf('App launcher')).queryByRole('alert')).toBeNull()
  })

  it('should reset the launcher to the default at once, and offer no reset when it is the default', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServerPage({
      domain: 'lab.rathole.example.com',
      tab: 'default-apps',
      answers: { server_update: () => Promise.resolve(null) },
    })

    // Act
    const reset = await screen.findByRole('button', { name: 'Reset App Launcher URL to default' })
    expect(reset.textContent).toBe('Reset to default')
    await user.click(reset)

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_update',
      args: {
        domain: 'lab.rathole.example.com',
        launcherUrl: DEFAULT_LAUNCHER_URL,
        authorizationUrl: 'http://localhost:5300/authorization/',
        certificateAuthority: 'letsEncryptStaging',
      },
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Reset App Launcher URL to default' })).toBeNull()
    })
    expect(screen.getByLabelText('App launcher')).toHaveProperty('value', DEFAULT_LAUNCHER_URL)
    cleanup()

    // Act
    renderServerPage({ domain: 'ruth.relay.example.com', tab: 'default-apps' })

    // Assert
    expect(await screen.findByLabelText('App launcher')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Reset App Launcher URL to default' })).toBeNull()
  })

  it('should reset the Authorization app to the default at once, keeping the launcher', async () => {
    // Arrange
    const user = userEvent.setup()
    const host = renderServerPage({
      domain: 'lab.rathole.example.com',
      tab: 'default-apps',
      answers: { server_update: () => Promise.resolve(null) },
    })

    // Act
    const reset = await screen.findByRole('button', {
      name: 'Reset Authorization Manager URL to default',
    })
    expect(reset.textContent).toBe('Reset to default')
    await user.click(reset)

    // Assert
    expect(host.seen).toContainEqual({
      command: 'server_update',
      args: {
        domain: 'lab.rathole.example.com',
        launcherUrl: 'http://localhost:5200/app',
        authorizationUrl: DEFAULT_AUTHORIZATION_URL,
        certificateAuthority: 'letsEncryptStaging',
      },
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Reset Authorization Manager URL to default' })
      ).toBeNull()
    })
    expect(screen.getByLabelText('Authorization')).toHaveProperty(
      'value',
      DEFAULT_AUTHORIZATION_URL
    )
    expect(screen.getByRole('button', { name: 'Reset App Launcher URL to default' })).toBeDefined()
  })

  it.each([
    ['the default with its host in another case', 'https://Launcher.WildflowerHealth.IO/', false],
    ['the default with its default port', 'https://launcher.wildflowerhealth.io:443/', false],
    ['a launcher that is not a URL', 'not a url', true],
  ] as const)(
    'should compare a launcher with the default as URLs: %s',
    async (_, launcherUrl, offersReset) => {
      // Act
      renderServerPage({
        domain: 'ruth.relay.example.com',
        tab: 'default-apps',
        servers: [{ ...golden.listedServers[0], launcherUrl }, golden.listedServers[1]],
      })

      // Assert
      expect(await screen.findByLabelText('App launcher')).toHaveProperty('value', launcherUrl)
      expect(
        screen.queryByRole('button', { name: 'Reset App Launcher URL to default' }) !== null
      ).toBe(offersReset)
    }
  )
})
