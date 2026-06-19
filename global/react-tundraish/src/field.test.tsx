import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { Field, FieldDescription, FieldGroup } from './field.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Field', () => {
  it('renders the label and child content together', () => {
    // Arrange
    // Act
    render(
      <Field label="Email">
        <span>alice@example.com</span>
      </Field>
    )

    // Assert
    expect(screen.getByText('Email')).toBeTruthy()
    expect(screen.getByText('alice@example.com')).toBeTruthy()
  }, 15_000)

  it('typesets the label with the Field eyebrow class', () => {
    // Arrange
    // Act
    render(<Field label="Name">value</Field>)

    // Assert — the label carries Field's own eyebrow treatment (small mono
    // uppercase) instead of a tundra-css text-label-N utility; the design's
    // field label role doesn't sit on that scale.
    const label = screen.getByText('Name')
    expect(label.className).toMatch(/field__label/)
    expect(label.classList.contains('text-label-3')).toBe(false)
  })

  it('renders a plain span label (no control association) when htmlFor is omitted', () => {
    // Arrange / Act
    render(
      <Field label="Application">
        <span>acme</span>
      </Field>
    )

    // Assert — read-only value, so the label is not a <label> element.
    const label = screen.getByText('Application')
    expect(label.tagName).toBe('SPAN')
  })

  it('associates the label with its control when htmlFor is set', () => {
    // Arrange / Act
    render(
      <Field label="Public host" htmlFor="host-input">
        <input id="host-input" defaultValue="example.com" />
      </Field>
    )

    // Assert — the input is reachable by its visible label text.
    const input = screen.getByLabelText('Public host')
    if (!(input instanceof HTMLInputElement)) throw new Error('expected an <input>')
    expect(input.value).toBe('example.com')
  })
})

describe('FieldGroup', () => {
  it('exposes a named group so the label names a set of controls', () => {
    // Arrange / Act
    render(
      <FieldGroup label="Requested Scopes">
        <input type="checkbox" aria-label="read" />
        <input type="checkbox" aria-label="write" />
      </FieldGroup>
    )

    // Assert — a single role=group named by the label, containing both controls.
    const group = screen.getByRole('group', { name: 'Requested Scopes' })
    expect(group.querySelectorAll('input[type="checkbox"]').length).toBe(2)
  })
})

describe('FieldDescription', () => {
  it('renders its children with the field helper-text class (not a tundra body utility)', () => {
    // Arrange
    // Act
    render(<FieldDescription>Helpful hint.</FieldDescription>)

    // Assert — the helper carries Field's own description treatment
    // (sans, ~14px, muted) rather than tundra-css's `text-body-3` which
    // resolves to the page's 16px body size and visually competes with
    // the field's primary value.
    const description = screen.getByText('Helpful hint.')
    expect(description.className).toMatch(/field__description/)
    expect(description.classList.contains('text-body-3')).toBe(false)
  })
})
