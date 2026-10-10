import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { defaultConfig } from './config.ts'
import { RexallConfigForm } from './rexall-config-form.tsx'

afterEach(() => {
  cleanup()
})

/** Render `RexallConfigForm` standalone, with a `type="submit"` footer. */
const renderRexallForm = (
  overrides: {
    readonly initial?: typeof defaultConfig
    readonly prefill?: Record<string, string>
  } = {}
): { readonly onSubmit: ReturnType<typeof vi.fn> } => {
  const onSubmit = vi.fn()
  render(
    <RexallConfigForm
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

describe('RexallConfigForm', () => {
  test('seeds fields from defaultConfig and submits a decoded config', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderRexallForm()

    expect(screen.getByDisplayValue(defaultConfig.email)).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.password)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(defaultConfig)
  })

  test('seeds fields from an existing `initial` config on edit', () => {
    const initial = {
      _tag: 'rexall',
      email: 'member@rexall.test',
      password: 'stored-secret',
    } as const
    renderRexallForm({ initial })

    expect(screen.getByDisplayValue(initial.email)).toBeTruthy()
    expect(screen.getByDisplayValue(initial.password)).toBeTruthy()
  })

  test('a `prefill` key overrides the default while others fall back', () => {
    renderRexallForm({ prefill: { email: 'prefilled@rexall.test' } })

    expect(screen.getByDisplayValue('prefilled@rexall.test')).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.password)).toBeTruthy()
  })

  test('an invalid email blocks submit with an inline error, then submits once fixed', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderRexallForm()

    const email = screen.getByLabelText('Email')
    await user.clear(email)
    await user.type(email, 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Blocked at the client — no bad config round-trips to the server.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/email/i)).toBeTruthy()

    // Fixing the field and resubmitting decodes and forwards the config.
    await user.clear(email)
    await user.type(email, 'fixed@rexall.test')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      _tag: 'rexall',
      email: 'fixed@rexall.test',
      password: defaultConfig.password,
    })
  })
})
