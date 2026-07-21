import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { defaultConfig } from './config.ts'
import { LifeLabsConfigForm } from './lifelabs-config-form.tsx'

afterEach(() => {
  cleanup()
})

/** Render `LifeLabsConfigForm` standalone, with a `type="submit"` footer. */
const renderLifeLabsForm = (
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
    const { onSubmit } = renderLifeLabsForm()

    expect(screen.getByDisplayValue(defaultConfig.username)).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.password)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(defaultConfig)
  })

  test('seeds fields from an existing `initial` config on edit', () => {
    const initial = {
      _tag: 'lifelabs',
      username: 'member@lifelabs.test',
      password: 'stored-secret',
    } as const
    renderLifeLabsForm({ initial })

    expect(screen.getByDisplayValue(initial.username)).toBeTruthy()
    expect(screen.getByDisplayValue(initial.password)).toBeTruthy()
  })

  test('a `prefill` key overrides the default while others fall back', () => {
    renderLifeLabsForm({ prefill: { username: 'prefilled@lifelabs.test' } })

    expect(screen.getByDisplayValue('prefilled@lifelabs.test')).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.password)).toBeTruthy()
  })

  test('a whitespace username blocks submit with an inline error, then submits once fixed', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderLifeLabsForm()

    const username = screen.getByLabelText('Username')
    await user.clear(username)
    await user.type(username, 'has space')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Blocked at the client — no bad config round-trips to the server.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/username/i)).toBeTruthy()

    // Fixing the field and resubmitting decodes and forwards the config.
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
