import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { defaultConfig } from './config.ts'
import { ShoppersDrugMartConfigForm } from './shoppers-drugmart-config-form.tsx'

afterEach(() => {
  cleanup()
})

/** Render `ShoppersDrugMartConfigForm` standalone, with a `type="submit"` footer. */
const renderForm = (
  overrides: {
    readonly initial?: typeof defaultConfig
    readonly prefill?: Record<string, string>
  } = {}
): { readonly onSubmit: ReturnType<typeof vi.fn> } => {
  const onSubmit = vi.fn()
  render(
    <ShoppersDrugMartConfigForm
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

describe('ShoppersDrugMartConfigForm', () => {
  test('seeds fields from defaultConfig and submits a decoded config', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    expect(screen.getByDisplayValue(defaultConfig.email)).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.password)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(defaultConfig)
  })

  test('seeds fields from an existing `initial` config on edit', () => {
    const initial = {
      _tag: 'shoppers-drugmart',
      email: 'member@shoppers.test',
      password: 'existing-pw',
    } as const
    renderForm({ initial })

    expect(screen.getByDisplayValue(initial.email)).toBeTruthy()
    expect(screen.getByDisplayValue(initial.password)).toBeTruthy()
  })

  test('a `prefill` key overrides the default while others fall back', () => {
    renderForm({ prefill: { email: 'prefill@shoppers.test' } })

    expect(screen.getByDisplayValue('prefill@shoppers.test')).toBeTruthy()
    expect(screen.getByDisplayValue(defaultConfig.password)).toBeTruthy()
  })

  test('an invalid email blocks submit with an inline error, then submits once fixed', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    const email = screen.getByLabelText('Email')
    await user.clear(email)
    await user.type(email, 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Blocked at the client — no bad config round-trips to the server.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/email/i)).toBeTruthy()

    await user.clear(email)
    await user.type(email, 'fixed@shoppers.test')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      _tag: 'shoppers-drugmart',
      email: 'fixed@shoppers.test',
      password: defaultConfig.password,
    })
  })
})
