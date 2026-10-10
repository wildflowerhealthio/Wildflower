import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { defaultConfig } from './config.ts'
import { WebTraceConfigForm } from './web-trace-config-form.tsx'

afterEach(() => {
  cleanup()
})

/** Render `WebTraceConfigForm` standalone, with a `type="submit"` footer. */
const renderWebTraceForm = (
  overrides: {
    readonly initial?: typeof defaultConfig
    readonly prefill?: Record<string, string>
  } = {}
): { readonly onSubmit: ReturnType<typeof vi.fn> } => {
  const onSubmit = vi.fn()
  render(
    <WebTraceConfigForm
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

describe('WebTraceConfigForm', () => {
  test('seeds fields from defaultConfig and submits a decoded config', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderWebTraceForm()

    expect(screen.getByDisplayValue(defaultConfig.rootUrl)).toBeTruthy()
    expect(screen.getByDisplayValue('json, text, html, xml')).toBeTruthy()
    // The cap is edited in KiB and stored in bytes.
    expect(screen.getByDisplayValue('1024')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(defaultConfig)
  })

  test('omits sessionLabel entirely rather than submitting an empty string', async () => {
    // `listSubtitle` reads the label to decide whether to show a suffix, so an
    // empty string and an absent label are not interchangeable.
    const user = userEvent.setup()
    const { onSubmit } = renderWebTraceForm()

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('sessionLabel')
  })

  test('seeds fields from an existing `initial` config on edit', () => {
    const initial = {
      _tag: 'web-trace',
      rootUrl: 'https://portal.example.com/login',
      sessionLabel: 'refill flow',
      bodyContentTypes: ['fhir+json'],
      maxBodyBytes: 2048,
    } as const
    renderWebTraceForm({ initial })

    expect(screen.getByDisplayValue(initial.rootUrl)).toBeTruthy()
    expect(screen.getByDisplayValue('refill flow')).toBeTruthy()
    expect(screen.getByDisplayValue('fhir+json')).toBeTruthy()
    expect(screen.getByDisplayValue('2')).toBeTruthy()
  })

  test('a `prefill` key overrides the default while others fall back', () => {
    renderWebTraceForm({ prefill: { rootUrl: 'https://prefilled.example.com' } })

    expect(screen.getByDisplayValue('https://prefilled.example.com')).toBeTruthy()
    expect(screen.getByDisplayValue('json, text, html, xml')).toBeTruthy()
  })

  test('trims and lower-cases the content-type list, dropping empty entries', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderWebTraceForm()

    const types = screen.getByLabelText('Store bodies for')
    await user.clear(types)
    await user.type(types, ' JSON , , FHIR+JSON ,')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ bodyContentTypes: ['json', 'fhir+json'] })
    )
  })

  test('a non-http start URL blocks submit with an inline error, then submits once fixed', async () => {
    // `ftp://` rather than `not-a-url` on purpose: the input is `type="url"`, so
    // a malformed string never reaches the handler — the browser's own
    // constraint validation stops the submit first. A well-formed URL with the
    // wrong scheme is the case only the schema can catch, so it is the one that
    // exercises this form's validation rather than the platform's.
    const user = userEvent.setup()
    const { onSubmit } = renderWebTraceForm()

    const rootUrl = screen.getByLabelText('Start URL')
    await user.clear(rootUrl)
    await user.type(rootUrl, 'ftp://files.example.com')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Blocked at the client — no bad config round-trips to the server.
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/http\(s\) URL/i)).toBeTruthy()

    await user.clear(rootUrl)
    await user.type(rootUrl, 'https://fixed.example.com')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      ...defaultConfig,
      rootUrl: 'https://fixed.example.com',
    })
  })

  test('a blank size cap blocks submit rather than silently becoming zero', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderWebTraceForm()

    const maxBody = screen.getByLabelText('Maximum body size (KiB)')
    await user.clear(maxBody)
    await user.type(maxBody, '1.5')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('says the allowlist governs bodies, not which requests are recorded', () => {
    // The single most misreadable thing about this collector's config; if the
    // hint goes away, a user will reasonably assume it filters requests.
    renderWebTraceForm()
    expect(screen.getByText(/Every request is recorded either way/i)).toBeTruthy()
  })
})
