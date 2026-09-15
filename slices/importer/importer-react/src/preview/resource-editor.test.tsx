import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Either } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { KeptEdit } from './resource-editor.tsx'

import {
  ImmutableFieldChangedError,
  InvalidJsonError,
  PlaceholderEditedWarning,
  prettyPrintResource,
  restoreSubstitutions,
  TRUNCATION_THRESHOLD,
  tryKeep,
} from './resource-editor-helpers.ts'
import { ResourceEditor } from './resource-editor.tsx'

// jsdom does not implement the native <dialog> element. Patch the two
// methods `Dialog` calls per-test and restore the descriptors after so the
// patches never leak across files. Same pattern the tundraish package uses
// in `dialog.test.tsx`.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')

const restore = (key: 'showModal' | 'close', descriptor: PropertyDescriptor | undefined): void => {
  if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  else Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})

/**
 * The inline JSON editor is one dialog with two invariants: an edit is
 * refused unless it parses as JSON and decodes through
 * `Schema.decodeUnknown(FhirResource)`, and `resourceType` / `id` are
 * read-only. `tryKeep` is exercised directly (the pure classifier); the
 * dialog is exercised as a whole to prove the UI wires them and shows the
 * failure rather than silently swallowing it.
 */

afterEach(() => {
  cleanup()
  restore('showModal', originalShowModal)
  restore('close', originalClose)
})

/** A minimal wire-shape Patient the FhirResource schema decodes. */
const validPatientJson = (id: string): string => JSON.stringify({ resourceType: 'Patient', id })

/** The parsed shape a preview would carry — the decoded form of the same wire. */
const parsedPatient = (id: string): unknown => ({
  resourceType: 'Patient',
  id,
  name: [{ given: [], family: 'Doe', text: '', prefix: [], suffix: [], use: null, period: null }],
})

describe('tryKeep', () => {
  it('should refuse text that is not valid JSON', () => {
    // Arrange
    const original = parsedPatient('pat-1')

    // Act
    const result = tryKeep('{ this is not json', original)

    // Assert
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(InvalidJsonError)
  })

  it('should refuse a schema-invalid edit', () => {
    // Arrange — a JSON body that does not decode as any FhirResource variant.
    const original = parsedPatient('pat-1')

    // Act — resourceType is not one of the recognised discriminants
    const result = tryKeep(JSON.stringify({ resourceType: 'NotAResource' }), original)

    // Assert
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      // A schema failure surfaces as a ParseError, not one of our own errors.
      expect(result.left).not.toBeInstanceOf(InvalidJsonError)
      expect(result.left).not.toBeInstanceOf(ImmutableFieldChangedError)
    }
  })

  it('should refuse a change to id', () => {
    // Arrange
    const original = parsedPatient('pat-1')

    // Act — same shape, different id
    const result = tryKeep(validPatientJson('pat-999'), original)

    // Assert
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result) && result.left instanceof ImmutableFieldChangedError) {
      expect(result.left.field).toBe('id')
    } else {
      throw new Error('expected an ImmutableFieldChangedError for id')
    }
  })

  it('should refuse a change to resourceType', () => {
    // Arrange — an Observation is a supported resource, but not the same type.
    const original = parsedPatient('pat-1')

    // Act
    const result = tryKeep(
      JSON.stringify({
        resourceType: 'Observation',
        id: 'pat-1',
        status: 'final',
        code: {},
      }),
      original
    )

    // Assert
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result) && result.left instanceof ImmutableFieldChangedError) {
      expect(result.left.field).toBe('resourceType')
    } else {
      throw new Error('expected an ImmutableFieldChangedError for resourceType')
    }
  })

  it('should keep a valid edit that preserves resourceType and id', () => {
    // Arrange
    const original = parsedPatient('pat-1')

    // Act — a valid variant edit that keeps the identity
    const result = tryKeep(validPatientJson('pat-1'), original)

    // Assert — the decoded resource comes back, ready for Review.edit
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.resourceType).toBe('Patient')
      expect(result.right.id).toBe('pat-1')
    }
  })
})

describe('prettyPrintResource truncation', () => {
  it('should leave short strings intact', () => {
    const resource = { resourceType: 'Patient', id: 'p-1', text: { div: '<div>hello</div>' } }
    const { text } = prettyPrintResource(resource)
    expect(text).toContain('<div>hello</div>')
  })

  it('should truncate string values at or above the threshold', () => {
    const longValue = 'x'.repeat(TRUNCATION_THRESHOLD)
    const resource = { resourceType: 'Patient', id: 'p-1', data: longValue }
    const { text } = prettyPrintResource(resource)
    expect(text).not.toContain(longValue)
    expect(text).toContain(`[${TRUNCATION_THRESHOLD.toLocaleString('en-US')} bytes]`)
  })

  it('should leave strings just below the threshold intact', () => {
    const justUnder = 'y'.repeat(TRUNCATION_THRESHOLD - 1)
    const resource = { resourceType: 'Patient', id: 'p-1', data: justUnder }
    const { text } = prettyPrintResource(resource)
    expect(text).toContain(justUnder)
  })

  it('should track substitutions with correct paths', () => {
    const longValue = 'z'.repeat(TRUNCATION_THRESHOLD)
    const resource = {
      resourceType: 'Patient',
      id: 'p-1',
      data: longValue,
      nested: { inner: longValue },
    }
    const { substitutions } = prettyPrintResource(resource)

    expect(substitutions).toHaveLength(2)
    expect(substitutions[0].path).toEqual(['data'])
    expect(substitutions[0].original).toBe(longValue)
    expect(substitutions[1].path).toEqual(['nested', 'inner'])
    expect(substitutions[1].original).toBe(longValue)
  })

  it('should track substitutions inside arrays', () => {
    const longValue = 'a'.repeat(TRUNCATION_THRESHOLD)
    const resource = { resourceType: 'Patient', id: 'p-1', items: ['short', longValue] }
    const { substitutions } = prettyPrintResource(resource)

    expect(substitutions).toHaveLength(1)
    expect(substitutions[0].path).toEqual(['items', 1])
    expect(substitutions[0].original).toBe(longValue)
  })
})

describe('restoreSubstitutions', () => {
  it('should restore unchanged placeholders to originals', () => {
    const longValue = 'x'.repeat(TRUNCATION_THRESHOLD)
    const resource = { resourceType: 'Patient', id: 'p-1', data: longValue }
    const { text, substitutions } = prettyPrintResource(resource)

    const parsed: unknown = JSON.parse(text)
    const { restored, editedPlaceholders } = restoreSubstitutions(parsed, substitutions)

    expect(editedPlaceholders).toHaveLength(0)
    expect(restored).toHaveProperty('data', longValue)
  })

  it('should detect when a placeholder was edited', () => {
    const longValue = 'x'.repeat(TRUNCATION_THRESHOLD)
    const resource = { resourceType: 'Patient', id: 'p-1', data: longValue }
    const { text, substitutions } = prettyPrintResource(resource)

    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null)
      Reflect.set(parsed, 'data', 'user typed something')
    const { restored, editedPlaceholders } = restoreSubstitutions(parsed, substitutions)

    expect(editedPlaceholders).toHaveLength(1)
    expect(editedPlaceholders[0].path).toEqual(['data'])
    expect(restored).toHaveProperty('data', 'user typed something')
  })

  it('should handle mixed edited and unedited placeholders', () => {
    const longA = 'a'.repeat(TRUNCATION_THRESHOLD)
    const longB = 'b'.repeat(TRUNCATION_THRESHOLD + 100)
    const resource = { resourceType: 'Patient', id: 'p-1', fieldA: longA, fieldB: longB }
    const { text, substitutions } = prettyPrintResource(resource)

    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null)
      Reflect.set(parsed, 'fieldA', 'replaced by user')
    // fieldB placeholder left intact
    const { restored, editedPlaceholders } = restoreSubstitutions(parsed, substitutions)

    expect(editedPlaceholders).toHaveLength(1)
    expect(editedPlaceholders[0].path).toEqual(['fieldA'])
    expect(restored).toHaveProperty('fieldA', 'replaced by user')
    expect(restored).toHaveProperty('fieldB', longB)
  })

  it('should be a no-op when there are no substitutions', () => {
    const obj = { foo: 'bar' }
    const { restored, editedPlaceholders } = restoreSubstitutions(obj, [])
    expect(restored).toBe(obj)
    expect(editedPlaceholders).toHaveLength(0)
  })
})

describe('tryKeep with substitutions', () => {
  it('should restore truncated fields when text is unedited', () => {
    const longValue = 'x'.repeat(TRUNCATION_THRESHOLD)
    const resource = { resourceType: 'Patient', id: 'pat-1', data: longValue }
    const { text, substitutions } = prettyPrintResource(resource)

    const result = tryKeep(text, resource, substitutions)

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.resourceType).toBe('Patient')
      expect(result.right.id).toBe('pat-1')
    }
  })

  it('should warn when a placeholder was edited', () => {
    const longValue = 'x'.repeat(TRUNCATION_THRESHOLD)
    const resource = { resourceType: 'Patient', id: 'pat-1', data: longValue }
    const { text, substitutions } = prettyPrintResource(resource)

    const edited = text.replace(
      `[${TRUNCATION_THRESHOLD.toLocaleString('en-US')} bytes]`,
      'replaced'
    )
    const result = tryKeep(edited, resource, substitutions)

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(PlaceholderEditedWarning)
    }
  })

  it('should proceed with force when a placeholder was edited', () => {
    const longValue = 'x'.repeat(TRUNCATION_THRESHOLD)
    const resource = { resourceType: 'Patient', id: 'pat-1', data: longValue }
    const { text, substitutions } = prettyPrintResource(resource)

    const edited = text.replace(
      `[${TRUNCATION_THRESHOLD.toLocaleString('en-US')} bytes]`,
      'replaced'
    )
    const result = tryKeep(edited, resource, substitutions, { force: true })

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.resourceType).toBe('Patient')
      expect(result.right.id).toBe('pat-1')
    }
  })
})

describe('ResourceEditor dialog', () => {
  it('should call onEdit with the decoded resource when a valid edit is kept', async () => {
    // Arrange
    const original = parsedPatient('pat-1')
    const onEdit = vi.fn<(edit: KeptEdit) => void>()
    render(
      <ResourceEditor open={true} resource={original} onEdit={onEdit} onCancel={() => undefined} />
    )

    // Act — replace the textarea's text with a valid Patient JSON that keeps
    // the same id, then click Keep.
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Resource JSON')
    await userEvent.clear(textarea)
    await userEvent.click(textarea)
    // Type via `.paste` because JSON with { and " is slower character-by-character
    await userEvent.paste(validPatientJson('pat-1'))
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))

    // Assert
    expect(onEdit).toHaveBeenCalledTimes(1)
    const [firstCall] = onEdit.mock.calls
    if (firstCall === undefined) throw new Error('unreachable: assertion above holds')
    const [{ resource: kept }] = firstCall
    expect(kept.resourceType).toBe('Patient')
    expect(kept.id).toBe('pat-1')
  })

  it('should surface a schema-invalid edit without calling onEdit', async () => {
    // Arrange
    const original = parsedPatient('pat-1')
    const onEdit = vi.fn<(edit: KeptEdit) => void>()
    render(
      <ResourceEditor open={true} resource={original} onEdit={onEdit} onCancel={() => undefined} />
    )

    // Act
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Resource JSON')
    await userEvent.clear(textarea)
    await userEvent.click(textarea)
    await userEvent.paste(JSON.stringify({ resourceType: 'Nope' }))
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))

    // Assert — the failure is surfaced (role="alert") and the edit was refused
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeDefined()
  })

  it('should preserve full data when Keep is clicked without editing a truncated resource', async () => {
    const longValue = 'z'.repeat(TRUNCATION_THRESHOLD + 500)
    const original = { resourceType: 'Patient', id: 'pat-1', data: longValue }
    const onEdit = vi.fn<(edit: KeptEdit) => void>()
    render(
      <ResourceEditor open={true} resource={original} onEdit={onEdit} onCancel={() => undefined} />
    )

    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Resource JSON')
    expect(textarea.value).toContain('bytes]')
    expect(textarea.value).not.toContain(longValue)

    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))

    expect(onEdit).toHaveBeenCalledTimes(1)
    const [firstCall] = onEdit.mock.calls
    if (firstCall === undefined) throw new Error('unreachable: assertion above holds')
    const [{ resource: kept }] = firstCall
    expect(kept.resourceType).toBe('Patient')
    expect(kept.id).toBe('pat-1')
  })

  it('should surface an id change as an ImmutableFieldChangedError', async () => {
    // Arrange
    const original = parsedPatient('pat-1')
    const onEdit = vi.fn<(edit: KeptEdit) => void>()
    render(
      <ResourceEditor open={true} resource={original} onEdit={onEdit} onCancel={() => undefined} />
    )

    // Act — try to save under a new id
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Resource JSON')
    await userEvent.clear(textarea)
    await userEvent.click(textarea)
    await userEvent.paste(validPatientJson('pat-2'))
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))

    // Assert
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/id/)
  })

  it('should warn and allow force-keep when a truncated field is edited', async () => {
    const longValue = 'q'.repeat(TRUNCATION_THRESHOLD + 200)
    const original = { resourceType: 'Patient', id: 'pat-1', data: longValue }
    const onEdit = vi.fn<(edit: KeptEdit) => void>()
    render(
      <ResourceEditor open={true} resource={original} onEdit={onEdit} onCancel={() => undefined} />
    )

    // Replace the placeholder with user text
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Resource JSON')
    const placeholder = `[${(TRUNCATION_THRESHOLD + 200).toLocaleString('en-US')} bytes]`
    const editedText = textarea.value.replace(`"${placeholder}"`, '"user-replacement"')
    await userEvent.clear(textarea)
    await userEvent.click(textarea)
    await userEvent.paste(editedText)

    // First Keep click → warning
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/truncated/)

    // Keep anyway → proceeds
    await userEvent.click(screen.getByRole('button', { name: 'Keep anyway' }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('should restore truncated data when text is edited elsewhere but placeholder is intact', async () => {
    const longValue = 'r'.repeat(TRUNCATION_THRESHOLD + 100)
    const original = {
      resourceType: 'Patient',
      id: 'pat-1',
      data: longValue,
      active: false,
    }
    const onEdit = vi.fn<(edit: KeptEdit) => void>()
    render(
      <ResourceEditor open={true} resource={original} onEdit={onEdit} onCancel={() => undefined} />
    )

    // Edit the `active` field but leave the truncated `data` placeholder intact
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Resource JSON')
    const editedText = textarea.value.replace('"active": false', '"active": true')
    await userEvent.clear(textarea)
    await userEvent.click(textarea)
    await userEvent.paste(editedText)

    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))

    // Should succeed without warning — placeholder was untouched, original restored
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})
