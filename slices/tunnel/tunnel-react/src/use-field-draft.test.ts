import { act, cleanup, renderHook, type RenderHookResult } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { useFieldDraft, type FieldDraft } from './use-field-draft.ts'

afterEach(() => {
  cleanup()
})

const KEYS = ['host', 'token'] as const
type Key = (typeof KEYS)[number]

const trimEquals = (draft: string, baseline: string): boolean => draft.trim() === baseline

const renderDraft = (
  baseline: Record<Key, string>,
  equals?: (a: string, b: string) => boolean
): RenderHookResult<FieldDraft<Key>, { b: Record<Key, string> }> =>
  renderHook(({ b }: { b: Record<Key, string> }) => useFieldDraft(KEYS, b, equals), {
    initialProps: { b: baseline },
  })

describe('useFieldDraft', () => {
  test('starts clean at the baseline', () => {
    const { result } = renderDraft({ host: 'a.example.com', token: '' })
    expect(result.current.fields).toEqual({ host: 'a.example.com', token: '' })
    expect(result.current.dirty).toBe(false)
    expect(result.current.changes).toEqual({})
  })

  test('setField dirties the field and surfaces it in changes', () => {
    const { result } = renderDraft({ host: 'a.example.com', token: '' })
    act(() => {
      result.current.setField('host', 'b.example.com')
    })
    expect(result.current.fields.host).toBe('b.example.com')
    expect(result.current.dirty).toBe(true)
    expect(result.current.changes).toEqual({ host: 'b.example.com' })
  })

  test('adopts a baseline change for an untouched field', () => {
    const { result, rerender } = renderDraft({ host: 'a.example.com', token: '' })
    rerender({ b: { host: 'c.example.com', token: '' } })
    expect(result.current.fields.host).toBe('c.example.com')
    expect(result.current.dirty).toBe(false)
  })

  test('preserves an unsaved edit when the baseline left that field alone', () => {
    const { result, rerender } = renderDraft({ host: 'a.example.com', token: '' })
    act(() => {
      result.current.setField('host', 'mine.example.com')
    })
    // An unrelated baseline update that leaves `host` alone must not clobber it.
    rerender({ b: { host: 'a.example.com', token: '' } })
    expect(result.current.fields.host).toBe('mine.example.com')
    expect(result.current.dirty).toBe(true)
  })

  test('rebases a locally-edited field when the baseline itself changed (a conflict)', () => {
    const { result, rerender } = renderDraft({ host: 'a.example.com', token: '' })
    act(() => {
      result.current.setField('host', 'mine.example.com')
    })
    rerender({ b: { host: 'other.example.com', token: '' } })
    expect(result.current.fields.host).toBe('other.example.com')
  })

  test('a write-only field (baseline always empty) survives an unrelated rebase', () => {
    const { result, rerender } = renderDraft({ host: 'a.example.com', token: '' })
    act(() => {
      result.current.setField('token', 'secret')
    })
    expect(result.current.changes).toEqual({ token: 'secret' })
    // The host rebases, but the never-echoed token keeps its typed value.
    rerender({ b: { host: 'other.example.com', token: '' } })
    expect(result.current.fields).toEqual({ host: 'other.example.com', token: 'secret' })
    expect(result.current.changes).toEqual({ token: 'secret' })
  })

  test('a custom equals ignores incidental whitespace', () => {
    const { result } = renderDraft({ host: 'a.example.com', token: '' }, trimEquals)
    act(() => {
      result.current.setField('host', '  a.example.com  ')
    })
    expect(result.current.dirty).toBe(false)
    expect(result.current.changes).toEqual({})
  })

  test('reset discards edits back to the baseline', () => {
    const { result } = renderDraft({ host: 'a.example.com', token: '' })
    act(() => {
      result.current.setField('host', 'mine.example.com')
      result.current.setField('token', 'secret')
    })
    act(() => {
      result.current.reset()
    })
    expect(result.current.fields).toEqual({ host: 'a.example.com', token: '' })
    expect(result.current.dirty).toBe(false)
  })
})
