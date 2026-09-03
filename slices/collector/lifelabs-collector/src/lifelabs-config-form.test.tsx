import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { defaultConfig } from './config.ts'
import { LifeLabsConfigForm } from './lifelabs-config-form.tsx'

afterEach(() => {
  cleanup()
})

/** Render `LifeLabsConfigForm` standalone, with a `type="submit"` footer. */
const renderForm = (
  overrides: {
    readonly initial?: typeof defaultConfig
    readonly prefill?: Record<string, string>
  } = {}
): { readonly onSubmit: ReturnType<typeof vi.fn> } => {
  const onSubmit = vi.fn()
  render(
    <LifeLabsConfigForm
      initial={overrides.initial}
      prefill={overrides.prefill}
      disabled={false}
      onSubmit={onSubmit}
      header={null}
      footer={<button type="submit">Save</button>}
    />
  )
  return { onSubmit }
}

describe('LifeLabsConfigForm', () => {
  test('seeds fields from defaultConfig and submits a decoded config', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    expect(screen.getByDisplayValue(defaultConfig.username)).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.password)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(defaultConfig)
  })

  test('seeds fields from an existing `initial` config on edit', () => {
    const initial = {
      _tag: 'lifelabs',
      username: 'member@lifelabs.test',
      password: 'existing-pw',
    } as const
    renderForm({ initial })

    expect(screen.getByDisplayValue(initial.username)).toBeTruthy()
    expect(screen.getByDisplayValue(initial.password)).toBeTruthy()
  })

  test('a `prefill` key overrides the default while others fall back', () => {
    renderForm({ prefill: { username: 'prefill@lifelabs.test' } })

    expect(screen.getByDisplayValue('prefill@lifelabs.test')).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.password)).toBeTruthy()
  })

  test('accepts a plain (non-email) username', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    const username = screen.getByLabelText('Username')
    await user.clear(username)
    await user.type(username, 'jdoe42')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      _tag: 'lifelabs',
      username: 'jdoe42',
      password: defaultConfig.password,
    })
  })

  test('a username with whitespace blocks submit with an inline error, then submits once fixed', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    const username = screen.getByLabelText('Username')
    await user.clear(username)
    await user.type(username, 'has space')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Blocked at the client — no bad config round-trips to the server.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/no whitespace/i)).toBeTruthy()

    await user.clear(username)
    await user.type(username, 'fixed@lifelabs.test')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      _tag: 'lifelabs',
      username: 'fixed@lifelabs.test',
      password: defaultConfig.password,
    })
  })
})
