import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { Field, FieldDescription } from './field.tsx'

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

  it('typesets the label with the Tundra text-label-3 utility class', () => {
    // Arrange
    // Act
    render(<Field label="Name">value</Field>)

    // Assert
    expect(screen.getByText('Name').classList.contains('text-label-3')).toBe(true)
  })
})

describe('FieldDescription', () => {
  it('renders its children with the text-body-3 utility class', () => {
    // Arrange
    // Act
    render(<FieldDescription>Helpful hint.</FieldDescription>)

    // Assert
    const description = screen.getByText('Helpful hint.')
    expect(description.classList.contains('text-body-3')).toBe(true)
  })
})
